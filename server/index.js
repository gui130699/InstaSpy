const express = require('express');
const cors = require('cors');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const { IgApiClient, IgCheckpointError, IgLoginTwoFactorRequiredError } = require('instagram-private-api');
const { v4: uuid } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const PORT = 3001;

// Arquivo de log para diagnóstico
const LOG_FILE = path.join(__dirname, 'server.log');
const _origLog  = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origErr  = console.error.bind(console);
function writeLog(prefix, args) {
  const line = `[${new Date().toISOString()}] ${prefix} ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
}
console.log   = (...a) => { _origLog(...a);   writeLog('LOG ', a); };
console.warn  = (...a) => { _origWarn(...a);  writeLog('WARN', a); };
console.error = (...a) => { _origErr(...a);   writeLog('ERR ', a); };

// Rota para expor logs (últimas 200 linhas)
// GET /api/logs?tail=200

/* ── Armazenamento em memória de sessões ─────────────────────────────────── */
const sessions = new Map();
const collectionProgress = new Map(); // token → { active, step, message, pct }
// Cursores salvos quando a coleta é interrompida por bloqueio — retomada automática
// key: `${userId}:followers` | `${userId}:following`  value: { cursor, items, savedAt }
const resumeCursors = new Map();

/* ══════════════════════════════════════════════════════════════════════════
   UTILITÁRIOS HTTP
   ══════════════════════════════════════════════════════════════════════════ */

const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const MOBILE_UA = 'Instagram 275.0.0.27.98 Android (31/12; 560dpi; 1440x2960; samsung; SM-G988B; y2q; exynos990; en_US; 458229258)';

function httpsReq(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const options = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: opts.headers || {},
    };
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        // Se caller pedir buffer raw, entregar; caso contrário string
        const body = opts.rawBuffer ? raw : raw.toString();
        const setCookies = res.headers['set-cookie'] || [];
        resolve({ status: res.statusCode, headers: res.headers, setCookies, body });
      });
    });
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   INSTAGRAM HELPERS
   ══════════════════════════════════════════════════════════════════════════ */

/** Busca cookies iniciais do Instagram (csrftoken, mid, ig_did, datr) */
async function fetchInitialCookies(ua) {
  const res = await httpsReq('https://www.instagram.com/accounts/login/', {
    headers: { 'User-Agent': ua || WEB_UA, 'Accept': 'text/html', 'Accept-Language': 'pt-BR,pt;q=0.9' }
  });
  const cookies = {};
  for (const sc of res.setCookies) {
    const m = sc.match(/^([^=]+)=([^;]*)/);
    if (m) cookies[m[1]] = m[2];
  }
  if (!cookies.csrftoken) {
    const m2 = res.body.match(/"csrf_token":"([^"]+)"/);
    if (m2) cookies.csrftoken = m2[1];
  }
  return cookies;
}

/** Dado apenas o valor do sessionid, constrói uma cookie string mínima */
function buildMinimalCookieStr(sessionid) {
  const decoded = decodeURIComponent(sessionid);
  const dsUserId = decoded.split(':')[0];
  const cookieStr = `sessionid=${sessionid}; ds_user_id=${dsUserId}; ig_nrcb=1`;
  return { cookieStr, dsUserId };
}

/** Extrai valor de um cookie da string */
function extractCookie(cookieStr, name) {
  const m = cookieStr.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

/** Monta cookie string completa com cookies de rastreamento (mid, csrftoken, ig_did).
 *  Cookies da sessão existente têm prioridade sobre os cookies de rastreamento frescos.
 *  Garante que o mid esteja sempre presente para evitar "useragent mismatch".
 */
async function enrichWebCookies(cookieStr, ua) {
  try {
    const sessionid = extractCookie(cookieStr, 'sessionid');
    if (!sessionid) return cookieStr;

    // Busca cookies de rastreamento frescos (mid, csrftoken, ig_did, datr) da página de login
    const tracking = await fetchInitialCookies(ua);

    // Parse cookies existentes da sessão
    const existing = {};
    for (const part of cookieStr.split(/;\s*/)) {
      const eq = part.indexOf('=');
      if (eq > 0) existing[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }

    // Merge: cookies da sessão têm prioridade (preserva mid original se existir)
    const merged = { ...tracking, ...existing };
    merged.ig_nrcb = '1';

    const result = Object.entries(merged)
      .filter(([, v]) => v && v !== 'deleted')
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');

    console.log(`[enrichWebCookies] ✓ cookies: ${Object.keys(merged).join(', ')}`);
    return result;
  } catch (e) {
    console.warn('[enrichWebCookies] Falhou, usando cookies originais:', e.message);
    return cookieStr;
  }
}

/** Faz GET autenticado no Instagram. webOnly=true força apenas www (para sessões web-login) */
async function igGet(path, cookieStr, ua, webOnly) {
  const csrftoken = extractCookie(cookieStr, 'csrftoken') || '';
  const effectiveUA = ua || WEB_UA;
  const hosts = webOnly ? ['www.instagram.com'] : ['www.instagram.com', 'i.instagram.com'];
  let lastErr = null;

  for (const host of hosts) {
    try {
      const isWeb = host === 'www.instagram.com';
      const igDid = extractCookie(cookieStr, 'ig_did') || '';
      const headers = {
        Cookie: cookieStr,
        'User-Agent': effectiveUA,
        'Accept': '*/*',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'X-CSRFToken': csrftoken,
        // Sessões web sempre usam App ID web — garante acesso com cookies de sessão web
        'X-IG-App-ID': '936619743392459',
        // Client Hints — exigidos pelo Instagram para validar sessões web
        'sec-ch-ua': '"Chromium";v="125", "Google Chrome";v="125", "Not-A.Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
      };
      if (isWeb) {
        headers['X-Requested-With'] = 'XMLHttpRequest';
        headers['X-IG-WWW-Claim'] = '0';
        headers['Sec-Fetch-Site'] = 'same-origin';
        headers['Sec-Fetch-Mode'] = 'cors';
        headers['Sec-Fetch-Dest'] = 'empty';
        headers['Referer'] = 'https://www.instagram.com/';
        headers['Origin'] = 'https://www.instagram.com';
        if (igDid) headers['X-Web-Device-Id'] = igDid;
      } else {
        // Para i.instagram.com com sessão web, adicionar headers mobile necessários
        headers['X-IG-WWW-Claim'] = '0';
        if (igDid) headers['X-IG-Device-ID'] = igDid;
      }
      const fullUrl = `https://${host}/api/v1${path}`;
      console.log(`[igGet] → ${fullUrl} | UA=${effectiveUA.substring(0,40)}... | webOnly=${!!webOnly}`);
      const res = await httpsReq(fullUrl, { headers });

      if (res.status === 301 || res.status === 302) { lastErr = new Error('redirect'); continue; }

      let json;
      try { json = JSON.parse(res.body); } catch {}

      console.log(`[igGet] ← status=${res.status} | msg=${json?.message || 'ok'} | host=${host}`);
      if (res.status !== 200) console.log(`[igGet] FULL BODY: ${res.body.substring(0, 500)}`);
      if (res.status === 200 && json) return json;
      if (json?.message === 'challenge_required') { lastErr = new Error('challenge_required'); continue; }
      if (json?.message) { lastErr = new Error(json.message); continue; }
      lastErr = new Error(`Status ${res.status}`);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Não foi possível conectar ao Instagram');
}

/** Faz POST no Instagram Web */
async function igPost(path, cookieStr, bodyStr) {
  const csrftoken = extractCookie(cookieStr, 'csrftoken') || 'x';
  const res = await httpsReq(`https://www.instagram.com${path}`, {
    method: 'POST',
    headers: {
      Cookie: cookieStr,
      'User-Agent': WEB_UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-CSRFToken': csrftoken,
      'X-IG-App-ID': '936619743392459',
      'X-Requested-With': 'XMLHttpRequest',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
      'Referer': 'https://www.instagram.com/accounts/login/',
      'Origin': 'https://www.instagram.com',
      'Accept': '*/*',
      'Accept-Language': 'pt-BR,pt;q=0.9',
    },
    body: bodyStr,
  });
  let json;
  try { json = JSON.parse(res.body); } catch { throw new Error('Resposta inesperada do Instagram'); }
  const newCookies = {};
  for (const sc of res.setCookies) {
    const m = sc.match(/^([^=]+)=([^;]*)/);
    if (m) newCookies[m[1]] = m[2];
  }
  return { json, newCookies, status: res.status };
}

function formatAccount(u) {
  return {
    pk: String(u.pk || u.pk_id || ''),
    username: u.username || '',
    full_name: u.full_name || '',
    avatar_url: u.profile_pic_url || u.hd_profile_pic_url_info?.url || '',
    followers_count: u.follower_count || 0,
    following_count: u.following_count || 0,
    posts_count: u.media_count || 0,
  };
}

/**
 * Busca dados do perfil via web_profile_info.
 * NOTA: Este endpoint retorna 429 de servidores (bloqueio CDN). Usado como tentativa inicial.
 */
async function fetchWebProfileInfo(username, cookieStr, ua) {
  if (!username) return null;
  try {
    const data = await igGet(`/users/web_profile_info/?username=${encodeURIComponent(username)}`, cookieStr, ua, true);
    // Suporta ambos os formatos: data.data.user e data.user
    const u = data?.data?.user || data?.user;
    if (!u) {
      console.warn('[fetchWebProfileInfo] RESPOSTA SEM user:', JSON.stringify(data).substring(0, 500));
      return null;
    }
    console.log(`[fetchWebProfileInfo] @${username}: is_private=${u.is_private} followers=${u.edge_followed_by?.count||u.follower_count} following=${u.edge_follow?.count||u.following_count} posts=${u.edge_owner_to_timeline_media?.count} avatar=${!!(u.profile_pic_url||u.profile_pic_url_hd)}`);
    const edges = u.edge_owner_to_timeline_media?.edges || [];
    const recentPosts = edges.map(e => e.node).filter(Boolean).map(p => ({
      post_id: p.id || '',
      caption: p.edge_media_to_caption?.edges?.[0]?.node?.text || '',
      media_url: p.display_url || p.thumbnail_src || '',
      created_at: (p.taken_at_timestamp || 0) * 1000,
      likes_count: p.edge_liked_by?.count || p.edge_media_preview_like?.count || 0,
      comments_count: p.edge_media_to_comment?.count || 0,
      likers_list: [],
    }));
    return {
      followers_count: u.edge_followed_by?.count ?? u.follower_count ?? null,
      following_count: u.edge_follow?.count    ?? u.following_count  ?? null,
      posts_count:     u.edge_owner_to_timeline_media?.count ?? u.media_count ?? null,
      avatar_url:      u.profile_pic_url_hd || u.hd_profile_pic_url_info?.url || u.profile_pic_url || '',
      is_private:      u.is_private || false,
      recentPosts,
    };
  } catch (e) {
    console.warn('[fetchWebProfileInfo] Erro:', e.message);
    return null;
  }
}

function isWebSession(s) { return s && s.type === 'web'; }

/**
 * Retorna cookieStr enriquecido com cookies de rastreamento frescos.
 * Usa cache por sessão — enriquece no máximo 1x a cada 10 minutos para
 * evitar rate limit. Atualiza s.cookieStr e s.lastEnrichedAt in-place.
 */
async function getEnrichedCookies(s) {
  const TEN_MIN = 10 * 60 * 1000;
  const stale = !s.lastEnrichedAt || (Date.now() - s.lastEnrichedAt) > TEN_MIN;
  if (stale) {
    try {
      const fresh = await enrichWebCookies(s.cookieStr, s.ua || WEB_UA);
      s.cookieStr = fresh;
      s.lastEnrichedAt = Date.now();
      console.log('[getEnrichedCookies] Cookies enriquecidos e cacheados');
    } catch (e) {
      console.warn('[getEnrichedCookies] Falhou, usando cookies originais:', e.message);
    }
  }
  return s.cookieStr;
}

/**
 * Raspa a página de perfil do Instagram e extrai dados do JSON embutido no HTML.
 * Esta abordagem bypassa o bloqueio CDN que afeta o endpoint web_profile_info
 * quando chamado de servidores.
 */
const BROWSER_HEADERS = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
  'sec-ch-ua': '"Chromium";v="125", "Google Chrome";v="125", "Not-A.Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'Cache-Control': 'max-age=0',
};

/** Extrai dados de perfil do HTML da página do Instagram.
 *  Retorna { followers_count, following_count, posts_count, avatar_url, is_private, user_id } ou null.
 */
async function fetchProfileFromHTML(username, cookieStr, ua) {
  try {
    const res = await httpsReq(`https://www.instagram.com/${encodeURIComponent(username)}/`, {
      headers: { Cookie: cookieStr, 'User-Agent': ua || WEB_UA, ...BROWSER_HEADERS }
    });

    console.log(`[fetchProfileFromHTML] @${username}: status=${res.status} len=${res.body.length}`);
    if (res.status !== 200) {
      console.warn(`[fetchProfileFromHTML] Status ${res.status} para @${username}`);
      return null;
    }

    const html = res.body;
    function decodeEmbedded(s) {
      return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
               .replace(/\\\//g, '/').replace(/\\"/g, '"');
    }

    // Extrai apenas os primeiros 20KB p/ meta tags (OG tags ficam no <head>)
    const headSection = html.substring(0, 20000);
    // Log diagnóstico do head
    const ogAny = headSection.match(/og:description[^>]+>/i) || headSection.match(/content="[^"]*seguidores[^"]*"/i) || headSection.match(/content="[^"]*Followers[^"]*"/i);
    console.log(`[fetchProfileFromHTML] @${username}: ogAny=${!!ogAny} headLen=${headSection.length}`);

    // --- Estratégia 1: Open Graph og:description ---
    // Formato PT: "355 seguidores, 187 seguindo, 107 publicações - Veja..."
    // Formato EN: "1,234 Followers, 567 Following, 89 Posts - See..."
    const ogDescMatch = headSection.match(/<meta[^>]+property\s*=\s*["']og:description["'][^>]+content\s*=\s*["']([^"']+)["']/i)
                     || headSection.match(/<meta[^>]+content\s*=\s*["']([^"']*(?:Followers?|seguidores)[^"']+)["'][^>]+property\s*=\s*["']og:description["']/i);

    function parseCount(str) {
      // Remove separadores de milhar (ponto PT ou vírgula EN) e converte
      if (!str) return null;
      return parseInt(str.replace(/[.,]/g, '')) || null;
    }

    if (ogDescMatch) {
      const desc = ogDescMatch[1];
      console.log(`[fetchProfileFromHTML] @${username}: og:description="${desc.substring(0, 140)}"`);
      // Seguidores: "1.163 seguidores" (PT) ou "1,163 Followers" (EN)
      const follM   = desc.match(/([\d,.]+)\s*(?:Followers?|seguidores)/i);
      // Seguindo: pode vir antes ou depois — "seguindo 1.540" OU "1.540 seguindo"
      const followM = desc.match(/seguindo\s*([\d,.]+)/i) || desc.match(/([\d,.]+)\s*(?:Following|seguindo)/i);
      // Posts: "132 posts" ou "132 publicações"
      const postsM  = desc.match(/([\d,.]+)\s*(?:Posts?|publica[çc][oõ]es)/i);
      const followers = parseCount(follM?.[1]);
      // Para "seguindo 1.540": followM[0] é o match, mas o número está em followM[1] para ambas formas
      const following = parseCount(followM?.[1]);
      const posts     = parseCount(postsM?.[1]);
      if (followers !== null || following !== null) {
        console.log(`[fetchProfileFromHTML] @${username}: OG followers=${followers} following=${following} posts=${posts}`);
        // og:image é a fonte mais confiável para o avatar (é específico deste perfil)
        const ogImgMatch    = headSection.match(/<meta[^>]+property\s*=\s*["']og:image["'][^>]+content\s*=\s*["']([^"']+)["']/i)
                            || headSection.match(/<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]+property\s*=\s*["']og:image["']/i);
        // Busca profile_pic_url próximo ao username (mais específico que match genérico)
        const proximityAvatar = html.match(new RegExp(`"username"\\s*:\\s*"${username}"[^}]{0,500}"profile_pic_url_hd"\\s*:\\s*"(https[^"]+)"`))
                             || html.match(new RegExp(`"profile_pic_url_hd"\\s*:\\s*"(https[^"]+)"[^}]{0,500}"username"\\s*:\\s*"${username}"`));
        const privateMatch  = html.match(/"is_private"\s*:\s*(true|false)/);
        // Prefere og:image (sempre é do perfil alvo), depois proximity match, depois match genérico
        const rawAvatarUrl = ogImgMatch?.[1] || proximityAvatar?.[1] || '';
        // Decodifica entidades HTML (&amp; → &) e escapes unicode
        const avatar_url_og = rawAvatarUrl
          ? rawAvatarUrl.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
          : '';
        console.log(`[fetchProfileFromHTML] @${username}: ogImg=${!!ogImgMatch} avatar_url_og=${avatar_url_og.substring(0, 80)}`);
        // Extrai user_id do HTML mesmo no path OG
        let og_user_id = null;
        const ogPkM  = html.match(new RegExp(`"pk"\\s*:\\s*"(\\d+)"[^}]{0,200}"username"\\s*:\\s*"${username}"`));
        const ogPkM2 = html.match(new RegExp(`"username"\\s*:\\s*"${username}"[^}]{0,200}"pk"\\s*:\\s*"(\\d+)"`));
        const ogIdM  = html.match(new RegExp(`"id"\\s*:\\s*"(\\d{6,20})"[^}]{0,200}"username"\\s*:\\s*"${username}"`));
        const ogIdM2 = html.match(new RegExp(`"username"\\s*:\\s*"${username}"[^}]{0,200}"id"\\s*:\\s*"(\\d{6,20})"`));
        const ogRelayM = html.match(new RegExp(`profilePage_(\\d{6,20})`));
        const ogDsM  = html.match(/"owner"\s*:\s*\{"__typename"\s*:\s*"[^"]*"\s*,\s*"id"\s*:\s*"(\d{6,20})"/);
        og_user_id = ogPkM?.[1] || ogPkM2?.[1] || ogIdM?.[1] || ogIdM2?.[1] || ogDsM?.[1] || ogRelayM?.[1] || null;
        if (og_user_id) console.log(`[fetchProfileFromHTML] @${username}: user_id via OG path=${og_user_id}`);
        return {
          followers_count: followers ?? 0,
          following_count: following ?? 0,
          posts_count:     posts ?? 0,
          avatar_url: avatar_url_og,
          is_private: privateMatch?.[1] === 'true',
          user_id: og_user_id,
        };
      }
    }

    const privateMatch  = html.match(/"is_private"\s*:\s*(true|false)/);
    const avatarHdMatch = html.match(/"profile_pic_url_hd"\s*:\s*"(https[^"]+)"/);
    const avatarMatch   = html.match(/"profile_pic_url"\s*:\s*"(https[^"]+)"/);
    const avatar_url    = decodeEmbedded(avatarHdMatch?.[1] || avatarMatch?.[1] || '');
    const is_private    = privateMatch?.[1] === 'true';

    // Extrai user_id do HTML (pk ou id numérico junto do username)
    let user_id = null;
    const pkMatch = html.match(new RegExp(`"pk"\\s*:\\s*"(\\d+)"[^}]{0,200}"username"\\s*:\\s*"${username}"`));
    const pkMatch2 = html.match(new RegExp(`"username"\\s*:\\s*"${username}"[^}]{0,200}"pk"\\s*:\\s*"(\\d+)"`));
    const idMatch  = html.match(new RegExp(`"id"\\s*:\\s*"(\\d{6,20})"[^}]{0,200}"username"\\s*:\\s*"${username}"`));
    const idMatch2 = html.match(new RegExp(`"username"\\s*:\\s*"${username}"[^}]{0,200}"id"\\s*:\\s*"(\\d{6,20})"`));
    user_id = pkMatch?.[1] || pkMatch2?.[1] || idMatch?.[1] || idMatch2?.[1] || null;
    if (user_id) console.log(`[fetchProfileFromHTML] @${username}: user_id extraído=${user_id}`);

    // Padrão 1: follower_count como número
    const followerMatch  = html.match(/"follower_count"\s*:\s*(\d+)/);
    const followingMatch = html.match(/"following_count"\s*:\s*(\d+)/);
    const mediaMatch     = html.match(/"media_count"\s*:\s*(\d+)/);
    if (followerMatch && followingMatch) {
      const result = {
        followers_count: parseInt(followerMatch[1]),
        following_count: parseInt(followingMatch[1]),
        posts_count: mediaMatch ? parseInt(mediaMatch[1]) : 0,
        avatar_url, is_private, user_id,
      };
      console.log(`[fetchProfileFromHTML] @${username}: followers=${result.followers_count} following=${result.following_count} posts=${result.posts_count}`);
      return result;
    }

    // Padrão 2: edge_followed_by (formato GraphQL antigo)
    const edgeFollower = html.match(/"edge_followed_by"\s*:\s*\{"count"\s*:\s*(\d+)\}/);
    const edgeFollow   = html.match(/"edge_follow"\s*:\s*\{"count"\s*:\s*(\d+)\}/);
    if (edgeFollower) {
      const result = {
        followers_count: parseInt(edgeFollower[1]),
        following_count: edgeFollow ? parseInt(edgeFollow[1]) : 0,
        posts_count: mediaMatch ? parseInt(mediaMatch[1]) : 0,
        avatar_url, is_private, user_id,
      };
      console.log(`[fetchProfileFromHTML] @${username}: edge format followers=${result.followers_count}`);
      return result;
    }

    // Conta não tem follower_count no HTML (privada ou não seguida) — retorna dados parciais
    const hasFollower = html.includes('follower_count') || html.includes('edge_followed_by');
    console.warn(`[fetchProfileFromHTML] @${username}: sem contagens no HTML. is_private=${is_private} hasFollowerKey=${hasFollower} user_id=${user_id}`);
    // Retorna null para contagens mas com dados disponíveis para uso pelo caller
    if (avatar_url || user_id) {
      return { followers_count: null, following_count: null, posts_count: null, avatar_url, is_private, user_id };
    }
    return null;
  } catch (e) {
    console.warn(`[fetchProfileFromHTML] Erro: ${e.message}`);
    return null;
  }
}

/** Tenta buscar perfil via ?__a=1&__d=dis — retorna JSON direto da página do perfil.
 *  Funciona para contas públicas; pode falhar/redirecionar para privadas.
 */
async function fetchProfile_a1(username, cookieStr, ua) {
  try {
    const csrftoken = extractCookie(cookieStr, 'csrftoken') || '';
    const res = await httpsReq(
      `https://www.instagram.com/${encodeURIComponent(username)}/?__a=1&__d=dis`,
      {
        headers: {
          Cookie: cookieStr,
          'User-Agent': ua || WEB_UA,
          'X-IG-App-ID': '936619743392459',
          'X-CSRFToken': csrftoken,
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
          'Referer': `https://www.instagram.com/${username}/`,
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Dest': 'empty',
        }
      }
    );
    console.log(`[fetchProfile_a1] @${username}: status=${res.status} len=${res.body?.length} snippet=${res.body?.substring(0,100)}`);
    if (res.status !== 200) return null;
    let json;
    try { json = JSON.parse(res.body); } catch { return null; }

    // Formato: { graphql: { user: {...} } } ou { data: { user: {...} } }
    const u = json?.graphql?.user || json?.data?.user || json?.user;
    if (!u || !u.username) return null;

    const followers = u.edge_followed_by?.count ?? u.follower_count ?? null;
    const following = u.edge_follow?.count ?? u.following_count ?? null;
    const posts     = u.edge_owner_to_timeline_media?.count ?? u.media_count ?? null;
    const avatar    = u.profile_pic_url_hd || u.hd_profile_pic_url_info?.url || u.profile_pic_url || '';
    console.log(`[fetchProfile_a1] @${username}: followers=${followers} following=${following} posts=${posts}`);
    return {
      username: u.username,
      avatar_url: avatar,
      followers_count: followers,
      following_count: following,
      posts_count: posts,
      is_private: u.is_private || false,
      user_id: String(u.pk || u.id || ''),
    };
  } catch (e) {
    console.warn(`[fetchProfile_a1] Erro: ${e.message}`);
    return null;
  }
}

/** Busca perfil via API mobile do Instagram (UA: app Android).
 *  Web session cookies também são válidos para a API mobile.
 */
async function fetchProfileMobileAPI(username, cookieStr) {
  const csrftoken = extractCookie(cookieStr, 'csrftoken') || '';
  const headers = {
    'User-Agent': MOBILE_UA,
    'Cookie': cookieStr,
    'X-IG-App-ID': '567067343352427',
    'X-CSRFToken': csrftoken,
    'Accept': '*/*',
    'Accept-Language': 'pt-BR, pt-BR;q=0.9, pt;q=0.8',
    'X-IG-Capabilities': '3brTv10=',
    'X-IG-Connection-Type': 'WIFI',
    'X-IG-Connection-Speed': '1000kbps',
    'X-IG-Bandwidth-Speed-KBPS': '-1.000',
    'X-IG-Bandwidth-TotalBytes-B': '0',
    'X-IG-Bandwidth-TotalTime-MS': '0',
  };
  try {
    const url = `https://i.instagram.com/api/v1/users/${encodeURIComponent(username)}/usernameinfo/`;
    console.log(`[fetchProfileMobileAPI] → ${url}`);
    const res = await httpsReq(url, { headers });
    console.log(`[fetchProfileMobileAPI] ← status=${res.status} body=${res.body.substring(0, 200)}`);
    if (res.status !== 200) return null;
    let json;
    try { json = JSON.parse(res.body); } catch { return null; }
    const u = json?.user;
    if (u && u.username) {
      return {
        username: u.username,
        avatar_url: u.profile_pic_url_hd || u.hd_profile_pic_url_info?.url || u.profile_pic_url || '',
        followers_count: u.follower_count || 0,
        following_count: u.following_count || 0,
        posts_count: u.media_count || 0,
        is_private: u.is_private || false,
      };
    }
    return null;
  } catch (e) {
    console.warn(`[fetchProfileMobileAPI] Erro: ${e.message}`);
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   ROTAS
   ══════════════════════════════════════════════════════════════════════════ */

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

/* ── 1. Login com senha (tenta WEB Ajax + fallback mobile API) ──────────── */
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });
  const clean = username.replace('@', '').trim().toLowerCase();

  /* ---- Tentativa 1: Login via Web Ajax ---- */
  try {
    console.log(`[login-web] Tentando login web para @${clean}...`);
    const initial = await fetchInitialCookies();
    const csrftoken = initial.csrftoken;
    if (!csrftoken) throw new Error('Sem csrftoken');

    const initCookieStr = Object.entries(initial).map(([k, v]) => `${k}=${v}`).join('; ');
    const body = `username=${encodeURIComponent(clean)}&enc_password=#PWD_INSTAGRAM_BROWSER:0:${Math.floor(Date.now() / 1000)}:${password}&queryParams={}&optIntoOneTap=false`;

    const { json, newCookies } = await igPost('/accounts/login/ajax/', initCookieStr, body);

    // Sucesso
    if (json.authenticated === true && json.userId) {
      const sessionid = newCookies.sessionid;
      if (!sessionid) throw new Error('sessionid não retornado');

      // Preservar todos os cookies (mid, ig_did, csrftoken) para evitar "useragent mismatch"
      // initial contém mid + ig_did + csrftoken; newCookies contém sessionid + ds_user_id + csrftoken atualizado
      const mergedCookies = { ...initial, ...newCookies };
      const cookieStr = Object.entries(mergedCookies)
        .filter(([, v]) => v && v !== 'deleted')
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');

      let user;
      try {
        const data = await igGet('/accounts/current_user/?edit=true', cookieStr, WEB_UA, true);
        user = data.user;
      } catch { user = { pk: json.userId, username: clean }; }

      const token = uuid();
      sessions.set(token, { type: 'web', cookieStr, userId: String(json.userId), username: user?.username || clean, ua: WEB_UA });

      console.log(`[login-web] ✅ @${user?.username || clean}`);
      return res.json({
        token,
        serialized: JSON.stringify({ type: 'web', cookieStr, ua: WEB_UA, username: user?.username || clean }),
        account: formatAccount(user || { pk: json.userId, username: clean }),
      });
    }

    // 2FA via web
    if (json.two_factor_required) {
      const tf = json.two_factor_info;
      const pendingId = uuid();
      sessions.set(`2fa_web_${pendingId}`, { type: 'web_2fa', username: clean, initialCookies: initial, twoFactorId: tf.two_factor_identifier, csrftoken });
      console.log(`[login-web] 2FA necessário`);
      return res.json({
        requires_2fa: true,
        pending_token: pendingId,
        message: `Código enviado por ${tf.sms_two_factor_on ? 'SMS' : 'app autenticador'}.`,
      });
    }

    // Checkpoint web
    if (json.checkpoint_url) {
      console.log(`[login-web] Checkpoint: ${json.checkpoint_url}`);
      // Cai no fallback mobile abaixo
    }

    if (json.message) console.log(`[login-web] Instagram: "${json.message}"`);
  } catch (webErr) {
    console.log(`[login-web] Falhou: ${webErr.message}`);
  }

  /* ---- Tentativa 2: Login via instagram-private-api (mobile) ---- */
  try {
    console.log(`[login-mobile] Tentando login mobile para @${clean}...`);
    const ig = new IgApiClient();
    ig.state.generateDevice(clean);
    await ig.simulate.preLoginFlow();
    const user = await ig.account.login(clean, password);
    const token = uuid();
    sessions.set(token, ig);
    const info = await ig.user.info(user.pk);
    console.log(`[login-mobile] ✅ @${user.username}`);
    return res.json({
      token,
      serialized: JSON.stringify(await ig.state.serialize()),
      account: formatAccount({ ...user, ...info }),
    });
  } catch (err) {
    if (err instanceof IgLoginTwoFactorRequiredError) {
      const data = err.response.body.two_factor_info;
      const pendingId = uuid();
      sessions.set(`2fa_mobile_${pendingId}`, { type: 'mobile_2fa', username: clean, password, twoFactorId: data.two_factor_identifier });
      console.log(`[login-mobile] 2FA necessário`);
      return res.json({
        requires_2fa: true,
        pending_token: pendingId,
        message: `Código enviado por ${data.sms_two_factor_on ? 'SMS' : 'app autenticador'}.`,
      });
    }
    if (err instanceof IgCheckpointError) {
      const ig2 = new IgApiClient();
      ig2.state.generateDevice(clean);
      const pendingId = uuid();
      sessions.set(`cp_${pendingId}`, { ig: ig2 });
      try { await ig2.challenge.auto(true); } catch {}
      console.log(`[login-mobile] Checkpoint necessário`);
      return res.json({
        requires_checkpoint: true,
        pending_token: pendingId,
        message: 'Verificação de segurança necessária. Verifique seu e-mail ou SMS.',
      });
    }
    console.error(`[login-mobile] Falhou: ${err.message}`);
    return res.status(400).json({
      error: 'Não foi possível fazer login. Tente o método "Login via Session ID".',
    });
  }
});

/* ── 2. Verificar 2FA ───────────────────────────────────────────────────── */
app.post('/api/auth/verify-2fa', async (req, res) => {
  const { pending_token, code } = req.body;
  const cleanCode = String(code).replace(/\s/g, '');

  // 2FA Web
  const webEntry = sessions.get(`2fa_web_${pending_token}`);
  if (webEntry) {
    try {
      const initCookieStr = Object.entries(webEntry.initialCookies).map(([k, v]) => `${k}=${v}`).join('; ');
      const body = `username=${webEntry.username}&verificationCode=${cleanCode}&identifier=${webEntry.twoFactorId}`;
      const { json, newCookies } = await igPost('/accounts/login/ajax/two_factor/', initCookieStr, body);

      if (json.authenticated && json.userId) {
        sessions.delete(`2fa_web_${pending_token}`);
        const sessionid = newCookies.sessionid;
        if (!sessionid) throw new Error('sessionid não retornado após 2FA');

        // Preservar todos os cookies (mid, ig_did, csrftoken) da sessão de login
        const mergedCookies = { ...webEntry.initialCookies, ...newCookies };
        const cookieStr = Object.entries(mergedCookies)
          .filter(([, v]) => v && v !== 'deleted')
          .map(([k, v]) => `${k}=${v}`)
          .join('; ');

        // Pular current_user — já temos o username do login, evita falha por useragent mismatch
        const token = uuid();
        const username = webEntry.username;
        sessions.set(token, { type: 'web', cookieStr, userId: String(json.userId), username, ua: WEB_UA });
        return res.json({
          token,
          serialized: JSON.stringify({ type: 'web', cookieStr, ua: WEB_UA, username }),
          account: formatAccount({ pk: json.userId, username }),
        });
      }
      throw new Error(json.message || 'Código 2FA inválido');
    } catch (err) {
      return res.status(400).json({ error: err.message || 'Código 2FA inválido' });
    }
  }

  // 2FA Mobile
  const mobileEntry = sessions.get(`2fa_mobile_${pending_token}`);
  if (mobileEntry) {
    try {
      const ig = new IgApiClient();
      ig.state.generateDevice(mobileEntry.username);
      await ig.simulate.preLoginFlow();
      try { await ig.account.login(mobileEntry.username, mobileEntry.password); } catch (loginErr) {
        if (loginErr instanceof IgLoginTwoFactorRequiredError) {
          const user = await ig.account.twoFactorLogin({
            username: mobileEntry.username,
            verificationCode: cleanCode,
            twoFactorIdentifier: mobileEntry.twoFactorId,
            verificationMethod: '1',
            trustThisDevice: '1',
          });
          sessions.delete(`2fa_mobile_${pending_token}`);
          const token = uuid();
          sessions.set(token, ig);
          const info = await ig.user.info(user.pk);
          return res.json({
            token,
            serialized: JSON.stringify(await ig.state.serialize()),
            account: formatAccount({ ...user, ...info }),
          });
        }
        throw loginErr;
      }
    } catch (err) {
      return res.status(400).json({ error: err.message || 'Código 2FA inválido' });
    }
  }

  // Fallback: 2FA legado (sem prefixo)
  const legacyEntry = sessions.get(`2fa_${pending_token}`);
  if (legacyEntry) {
    try {
      const user = await legacyEntry.ig.account.twoFactorLogin({
        username: legacyEntry.username,
        verificationCode: cleanCode,
        twoFactorIdentifier: legacyEntry.twoFactorId,
        verificationMethod: '1',
        trustThisDevice: '1',
      });
      sessions.delete(`2fa_${pending_token}`);
      const token = uuid();
      sessions.set(token, legacyEntry.ig);
      const info = await legacyEntry.ig.user.info(user.pk);
      return res.json({
        token,
        serialized: JSON.stringify(await legacyEntry.ig.state.serialize()),
        account: formatAccount({ ...user, ...info }),
      });
    } catch (err) {
      return res.status(400).json({ error: err.message || 'Código 2FA inválido' });
    }
  }

  return res.status(400).json({ error: 'Sessão 2FA expirada. Faça login novamente.' });
});

/* ── 3. Resolver checkpoint ─────────────────────────────────────────────── */
app.post('/api/auth/solve-checkpoint', async (req, res) => {
  const { pending_token, code } = req.body;
  const entry = sessions.get(`cp_${pending_token}`);
  if (!entry) return res.status(400).json({ error: 'Token expirado. Faça login novamente.' });

  try {
    await entry.ig.challenge.sendSecurityCode(String(code).replace(/\s/g, ''));
    sessions.delete(`cp_${pending_token}`);
    const token = uuid();
    sessions.set(token, entry.ig);
    const user = await entry.ig.account.currentUser();
    const info = await entry.ig.user.info(user.pk);
    res.json({
      token,
      serialized: JSON.stringify(await entry.ig.state.serialize()),
      account: formatAccount({ ...user, ...info }),
    });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Código de verificação inválido' });
  }
});

/* ── 4. Login via Session ID (só o valor do sessionid!) ─────────────────── */
app.post('/api/auth/cookie-login', async (req, res) => {
  let { cookies, userAgent } = req.body;
  const ua = (typeof userAgent === 'string' && userAgent.length > 10) ? userAgent : WEB_UA;
  if (!cookies || typeof cookies !== 'string') return res.status(400).json({ error: 'Session ID é obrigatório' });

  cookies = cookies.trim().replace(/^["']|["']$/g, '');

  // Detecta: só o valor do sessionid OU string completa de cookies
  let sessionid;
  if (cookies.includes('sessionid=')) {
    sessionid = extractCookie(cookies, 'sessionid');
  } else {
    sessionid = cookies;
  }

  if (!sessionid || sessionid.length < 10) {
    return res.status(400).json({ error: 'Session ID inválido. Cole o valor copiado de Application → Cookies → sessionid.' });
  }

  try {
    console.log(`[session-login] Construindo sessão (UA: ${ua.substring(0,60)}...)`);

    // Buscar cookies de rastreamento frescos (mid, csrftoken, ig_did) para o sessionid fornecido
    const tracking = await fetchInitialCookies(ua);
    const decoded = decodeURIComponent(sessionid);
    const dsUserId = decoded.split(':')[0];
    // Sessionid e ds_user_id do usuário têm prioridade sobre cookies de rastreamento
    const mergedCookies = { ...tracking, sessionid, ds_user_id: dsUserId, ig_nrcb: '1' };
    const cookieStr = Object.entries(mergedCookies)
      .filter(([, v]) => v && v !== 'deleted')
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');

    console.log(`[session-login] Validando sessão (ds_user_id=${dsUserId})...`);

    // Tenta múltiplos UAs — o sessionid pode ter sido criado com UA diferente
    const uasToTry = [
      ua,
      WEB_UA,
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    ];

    let user = null;
    let effectiveCookieStr = cookieStr;
    let effectiveUA = ua;

    for (const tryUA of uasToTry) {
      try {
        // Usa web_profile_info para extrair username do ds_user_id — não valida UA
        // Fallback: tenta current_user com cada UA
        const data = await igGet('/accounts/current_user/?edit=true', cookieStr, tryUA, true);
        if (data?.user?.pk) {
          user = data.user;
          effectiveUA = tryUA;
          console.log(`[session-login] current_user OK com UA: ${tryUA.substring(0,40)}...`);
          break;
        }
      } catch (e) {
        console.log(`[session-login] UA falhou (${e.message.substring(0,50)}), tentando próximo...`);
      }
    }

    // Se current_user falhou com todos os UAs, tenta ler via dsUserId diretamente
    if (!user && dsUserId && dsUserId !== '0' && dsUserId.length > 4) {
      console.log(`[session-login] Tentando user/info direto pelo ID ${dsUserId}...`);
      try {
        const infoData = await igGet(`/users/${dsUserId}/info/`, cookieStr, ua, false);
        if (infoData?.user) {
          user = { ...infoData.user, pk: infoData.user.pk || dsUserId };
          effectiveUA = ua;
          console.log(`[session-login] user/info OK: @${user.username}`);
        }
      } catch (e2) {
        console.log(`[session-login] user/info falhou: ${e2.message}`);
      }
    }

    if (!user || !user.pk) throw new Error('Não foi possível validar o Session ID. Verifique se o valor está correto e tente novamente.');

    const token = uuid();
    sessions.set(token, { type: 'web', cookieStr: effectiveCookieStr, userId: String(user.pk || dsUserId), username: user.username, ua: effectiveUA });

    console.log(`[session-login] ✅ @${user.username}`);
    return res.json({
      token,
      serialized: JSON.stringify({ type: 'web', cookieStr: effectiveCookieStr, ua: effectiveUA }),
      account: formatAccount(user),
    });
  } catch (err) {
    console.error(`[session-login] ❌ ${err.message}`);
    let errorMsg;
    if (err.message === 'challenge_required') {
      errorMsg = 'O Instagram pediu verificação. Abra instagram.com no navegador, resolva qualquer alerta, e tente novamente.';
    } else if (err.message.includes('login_required') || err.message.includes('redirect')) {
      errorMsg = 'Session ID expirado ou inválido. Faça login no instagram.com e copie o novo sessionid.';
    } else {
      errorMsg = err.message;
    }
    return res.status(401).json({ error: errorMsg });
  }
});

/* ── 5. Restaurar sessão (sem chamar Instagram — evita rate-limit) ───────── */
app.post('/api/auth/restore', async (req, res) => {
  const { token, serialized } = req.body;

  // 1. Token ainda está em memória? Retorna direto sem fazer request ao IG
  if (token && sessions.has(token)) {
    const s = sessions.get(token);
    const username = isWebSession(s) ? s.username : 'user';
    console.log(`[restore] Token em memória — @${username}`);
    return res.json({ ok: true, token, username });
  }

  // 2. Re-hidratar do serializado (sem validar com Instagram)
  if (serialized) {
    try {
      const parsed = JSON.parse(serialized);
      if (parsed.type === 'web' && parsed.cookieStr) {
        // Extrai ds_user_id do cookieStr
        const dsUserId = extractCookie(parsed.cookieStr, 'ds_user_id') || '0';
        const username = parsed.username || 'user';
        const newToken = uuid();
        sessions.set(newToken, {
          type: 'web',
          cookieStr: parsed.cookieStr,
          userId: dsUserId,
          username,
          ua: parsed.ua,
        });
        console.log(`[restore] Sessão web re-hidratada — @${username}`);
        return res.json({ ok: true, token: newToken, username });
      }
      const ig = new IgApiClient();
      await ig.state.deserialize(parsed);
      const newToken = uuid();
      sessions.set(newToken, ig);
      console.log('[restore] Sessão native re-hidratada');
      return res.json({ ok: true, token: newToken, username: 'user' });
    } catch (err) {
      console.warn('[restore] Falha ao re-hidratar:', err.message);
    }
  }

  res.json({ ok: false });
});

/* ══════════════════════════════════════════════════════════════════════════
   COLETA DE DADOS
   ══════════════════════════════════════════════════════════════════════════ */

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Faz igGet com retry + exponential backoff (anti rate-limit).
 * failFast=true: no máximo 2 tentativas c/ espera curta (10-15s) — para não travar quando bloqueado */
async function igGetSafe(path, cookieStr, ua, webOnly, retries = 5, failFast = false) {
  const maxTries = failFast ? 2 : retries;
  for (let attempt = 0; attempt < maxTries; attempt++) {
    try {
      return await igGet(path, cookieStr, ua, webOnly);
    } catch (err) {
      const msg = err.message || '';
      const isRateLimit = msg.includes('429') || msg.includes('Please wait') || msg.includes('spam')
        || msg.includes('Aguarde') || msg.includes('wait a few') || msg.includes('require_login')
        || msg.includes('too many') || msg.includes('Too Many') || msg.includes('rate limit');
      const isServerErr = msg.includes('500') || msg.includes('502') || msg.includes('503');
      if ((isRateLimit || isServerErr) && attempt < maxTries - 1) {
        const base = failFast ? 10000 : (isRateLimit ? 60000 : 8000);
        const delay = base * (attempt + 1) + Math.random() * (failFast ? 5000 : 20000);
        console.log(`[retry] Tentativa ${attempt + 1}/${maxTries} falhou (${msg}), aguardando ${Math.round(delay/1000)}s...`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
}

async function paginateFeed(feed, max = 1000) {
  const items = [];
  try {
    do {
      const page = await feed.items();
      items.push(...page);
      if (items.length >= max) break;
      await sleep(1500 + Math.random() * 1500);
    } while (feed.isMoreAvailable());
  } catch (err) { console.warn('[paginateFeed]', err.message); }
  return items;
}

/**
 * webPaginateFeed — pagina feed Instagram com pausa anti-rate-limit.
 * Pausa de 2 minutos a cada 500 itens (10 páginas de 50).
 * onCool(totalItens, segundos) — chamado antes de cada pausa de resfriamento.
 * failFast=true: delays menores, sem retry — para posts/likers.
 * resumeKey: chave string para salvar/retomar cursor em caso de bloqueio.
 */
async function webPaginateFeed(path, cookieStr, listKey, max = 10000, ua, webOnly, onPage = null, failFast = false, onCool = null, resumeKey = null) {
  const items = [];
  let maxId = '';
  let hasMore = true;
  let pageCount = 0;
  // A cada 10 páginas de 50 = 500 itens, faz pausa de 2 min
  const BATCH_PAGES = 10;
  const COOL_MIN    = 120000; // 2 minutos
  const COOL_MAX    = 150000; // 2,5 minutos
  const PAGE_MIN    = failFast ? 2000 : 8000;
  const PAGE_MAX    = failFast ? 4000 : 14000;

  // Retomar de cursor salvo anteriormente (bloqueio da coleta anterior)
  if (resumeKey && resumeCursors.has(resumeKey)) {
    const saved = resumeCursors.get(resumeKey);
    const ageH = ((Date.now() - saved.savedAt) / 3600000).toFixed(1);
    if (Date.now() - saved.savedAt < 24 * 3600000) { // válido por 24h
      console.log(`[webPaginateFeed] Retomando ${resumeKey}: ${saved.items.length} itens já carregados (salvo há ${ageH}h)`);
      items.push(...saved.items);
      maxId = saved.cursor;
      pageCount = Math.floor(saved.items.length / 50);
    } else {
      console.log(`[webPaginateFeed] Cursor de ${resumeKey} expirado (${ageH}h), começando do início`);
    }
    resumeCursors.delete(resumeKey);
  }

  while (hasMore && items.length < max) {
    try {
      const sep = path.includes('?') ? '&' : '?';
      const url = maxId ? `${path}${sep}max_id=${encodeURIComponent(maxId)}` : path;
      const data = await igGetSafe(url, cookieStr, ua, webOnly, failFast ? 1 : 5, failFast);
      function pickArr(...keys) {
        for (const k of keys) { if (Array.isArray(data[k]) && data[k].length > 0) return data[k]; }
        return [];
      }
      const list = pickArr(listKey, 'profile_grid_items', 'feed_items', 'users', 'items');
      if (items.length === 0 || (resumeKey && items.length < 60)) {
        console.log(`[webPaginateFeed(${path})] keys: ${Object.keys(data).join(', ')} | ${listKey}=${(data[listKey]||[]).length} selecionado=${list.length}`);
      }
      items.push(...list);
      pageCount++;
      if (onPage) onPage(items.length, list);
      const rawCursor = data.next_max_id ||
        (data.profile_grid_items_cursor != null && data.profile_grid_items_cursor !== ''
          ? (typeof data.profile_grid_items_cursor === 'object'
              ? JSON.stringify(data.profile_grid_items_cursor)
              : String(data.profile_grid_items_cursor))
          : '');
      hasMore = !!(rawCursor || data.more_available);
      maxId = rawCursor || '';
      if (hasMore && list.length > 0) {
        if (pageCount % BATCH_PAGES === 0) {
          const cooling = COOL_MIN + Math.random() * (COOL_MAX - COOL_MIN);
          const coolSecs = Math.round(cooling / 1000);
          console.log(`[webPaginateFeed] ${items.length} itens — pausa ${coolSecs}s anti-rate-limit...`);
          if (onCool) onCool(items.length, coolSecs);
          await sleep(cooling);
        } else {
          await sleep(PAGE_MIN + Math.random() * (PAGE_MAX - PAGE_MIN));
        }
      }
    } catch (err) {
      console.warn('[webPaginateFeed]', err.message);
      // Salvar cursor para retomar na próxima coleta
      if (resumeKey && maxId) {
        resumeCursors.set(resumeKey, { cursor: maxId, items: [...items], savedAt: Date.now() });
        console.log(`[webPaginateFeed] ⚠️ Cursor salvo para retomada (${resumeKey}): ${items.length} itens, cursor guardado`);
      }
      break;
    }
  }
  return { items, hasMore };
}

/* ── Progresso da coleta (polling) ───────────────────────────────────────── */
app.get('/api/collect/progress', (req, res) => {
  const token = req.headers['x-session-token'];
  const p = collectionProgress.get(token);
  res.json(p ?? { active: false });
});

/* ── Resumo rápido de perfil (web_profile_info → search → user/info por ID) ── */
app.get('/api/profile/:username', async (req, res) => {
  const token = req.headers['x-session-token'];
  const s = sessions.get(token);
  if (!s) return res.status(401).json({ error: 'Sessão inválida' });

  const username = (req.params.username || '').replace('@', '').trim().toLowerCase();
  if (!username) return res.status(400).json({ error: 'Username obrigatório' });

  console.log(`[profile] Buscando @${username}...`);

  try {
    // ── Sessão Nativa (instagram-private-api) ─────────────────────────────
    if (!isWebSession(s)) {
      const ig = s;
      try {
        const found = await ig.user.searchExact(username);
        if (!found) throw new Error('Não encontrado');
        const info = await ig.user.info(found.pk);
        return res.json({
          username: info.username,
          avatar_url: info.profile_pic_url || '',
          followers_count: info.follower_count || 0,
          following_count: info.following_count || 0,
          posts_count: info.media_count || 0,
        });
      } catch {
        return res.json({ username, avatar_url: '', followers_count: 0, following_count: 0, posts_count: 0, limited: true });
      }
    }

    // ── Sessão Web ─────────────────────────────────────────────────────────
    // Usa cookies enriquecidos com cache (atualiza no máximo 1x a cada 10 min)
    const cookieStr = await getEnrichedCookies(s);
    const ua = s.ua || WEB_UA;
    let foundUserId = null;
    let foundAvatarUrl = '';

    // Tentativa 1: Raspar página HTML do Instagram (extrai avatar, user_id, e contagens quando disponíveis)
    const html_data = await fetchProfileFromHTML(username, cookieStr, ua);
    if (html_data) {
      foundAvatarUrl = html_data.avatar_url || '';
      foundUserId = html_data.user_id || null;
      if (html_data.followers_count !== null) {
        console.log(`[profile] @${username} via HTML: followers=${html_data.followers_count}`);
        return res.json({
          username,
          avatar_url: foundAvatarUrl,
          followers_count: html_data.followers_count,
          following_count: html_data.following_count,
          posts_count: html_data.posts_count,
        });
      }
      console.log(`[profile] @${username}: HTML deu avatar/user_id mas sem contagens — seguindo tentativas...`);
    }

    // Tentativa 2: ?__a=1&__d=dis (JSON mode da página de perfil)
    const a1_data = await fetchProfile_a1(username, cookieStr, ua);
    if (a1_data && a1_data.followers_count !== null) {
      console.log(`[profile] @${username} via __a=1: followers=${a1_data.followers_count}`);
      return res.json({
        username: a1_data.username,
        avatar_url: a1_data.avatar_url || foundAvatarUrl,
        followers_count: a1_data.followers_count ?? 0,
        following_count: a1_data.following_count ?? 0,
        posts_count: a1_data.posts_count ?? 0,
      });
    }
    if (a1_data?.user_id) foundUserId = foundUserId || a1_data.user_id;
    if (a1_data?.avatar_url) foundAvatarUrl = foundAvatarUrl || a1_data.avatar_url;
    console.warn(`[profile] __a=1 falhou para @${username} — tentando mobile API...`);

    // Tentativa 3: Mobile API com UA do app Instagram Android
    const mobile_data = await fetchProfileMobileAPI(username, cookieStr);
    if (mobile_data) {
      console.log(`[profile] @${username} via mobile API OK (seg=${mobile_data.followers_count})`);
      return res.json({
        username: mobile_data.username,
        avatar_url: mobile_data.avatar_url || foundAvatarUrl,
        followers_count: mobile_data.followers_count,
        following_count: mobile_data.following_count,
        posts_count: mobile_data.posts_count,
      });
    }
    console.warn(`[profile] Mobile API falhou para @${username} — tentando web_profile_info...`);

    // Tentativa 4: web_profile_info (pode funcionar em alguns casos)
    let wpi = await fetchWebProfileInfo(username, cookieStr, ua);
    if (wpi) {
      const isAccessible = wpi.followers_count !== null && wpi.followers_count > 0;
      const limited = wpi.is_private && !isAccessible;
      console.log(`[profile] @${username} via web_profile_info OK (seg=${wpi.followers_count} snd=${wpi.following_count} limited=${limited})`);
      if (!limited) {
        return res.json({
          username,
          avatar_url: wpi.avatar_url || foundAvatarUrl || '',
          followers_count: wpi.followers_count ?? 0,
          following_count: wpi.following_count ?? 0,
          posts_count: wpi.posts_count ?? 0,
        });
      }
      foundAvatarUrl = wpi.avatar_url || foundAvatarUrl;
      console.warn(`[profile] @${username} é privado e dados limitados — tentando search...`);
    } else {
      console.warn(`[profile] web_profile_info falhou para @${username} — tentando search...`);
    }

    // Tentativa 5: user search → obtém user_id
    try {
      console.log(`[profile] Tentando busca pelo username @${username}...`);
      const searchData = await igGetSafe(
        `/users/search/?q=${encodeURIComponent(username)}&count=10`,
        cookieStr, ua, true, 1, true
      );
      const users = Array.isArray(searchData?.users) ? searchData.users : [];
      const found = users.find(u => u.username === username) || users.find(u => u.username?.includes(username));
      if (found) {
        foundUserId = found.pk || found.id;
        if (!foundAvatarUrl) foundAvatarUrl = found.profile_pic_url_hd || found.hd_profile_pic_url_info?.url || found.profile_pic_url || '';

        // Se a busca já retornou contagens, usar direto
        if (found.follower_count || found.following_count || found.media_count) {
          console.log(`[profile] @${username} via search OK (contagens disponíveis)`);
          return res.json({
            username: found.username || username,
            avatar_url: foundAvatarUrl,
            followers_count: found.follower_count || 0,
            following_count: found.following_count || 0,
            posts_count: found.media_count || 0,
          });
        }
      }
    } catch (searchErr) {
      console.warn(`[profile] user search falhou: ${searchErr.message}`);
    }

    // Tentativa 6: /api/v1/users/{id}/info/ via i.instagram.com
    if (foundUserId) {
      try {
        console.log(`[profile] Tentando user info por ID ${foundUserId}...`);
        // webOnly=false para usar i.instagram.com que respeita follows em privados
        const infoData = await igGetSafe(`/users/${foundUserId}/info/`, cookieStr, ua, false, 1, true);
        const u = infoData?.user;
        if (u && u.username) {
          console.log(`[profile] @${username} via user/info por ID OK`);
          return res.json({
            username: u.username || username,
            avatar_url: u.profile_pic_url_hd || u.hd_profile_pic_url_info?.url || u.profile_pic_url || foundAvatarUrl,
            followers_count: u.follower_count || 0,
            following_count: u.following_count || 0,
            posts_count: u.media_count || 0,
          });
        }
      } catch (infoErr) {
        console.warn(`[profile] user/info por ID falhou: ${infoErr.message}`);
      }
    }

    // Tentativa 7: username info endpoint (variante web)
    try {
      console.log(`[profile] Tentando usernameinfo para @${username}...`);
      const uiData = await igGetSafe(`/users/${encodeURIComponent(username)}/usernameinfo/`, cookieStr, ua, false, 1, true);
      const u = uiData?.user;
      if (u) {
        console.log(`[profile] @${username} via usernameinfo OK`);
        return res.json({
          username: u.username || username,
          avatar_url: u.profile_pic_url_hd || u.hd_profile_pic_url_info?.url || u.profile_pic_url || foundAvatarUrl,
          followers_count: u.follower_count || 0,
          following_count: u.following_count || 0,
          posts_count: u.media_count || 0,
        });
      }
    } catch { /* ignora */ }

    // Fallback: retornar dados mínimos com o que temos (avatar se conseguido)
    console.warn(`[profile] @${username}: dados limitados disponíveis`);
    return res.json({
      username,
      avatar_url: foundAvatarUrl,
      followers_count: 0,
      following_count: 0,
      posts_count: 0,
      limited: true,
    });
  } catch (err) {
    console.warn('[profile]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Proxy de avatar (evita CORS e URLs expiradas) ────────────────────────── */
app.get('/api/proxy/avatar', async (req, res) => {
  const url = String(req.query.url || '');
  // Permite apenas URLs de CDN do Instagram para segurança
  if (!url || !/(cdninstagram\.com|instagram\.com|fbcdn\.net)/.test(url)) {
    return res.status(400).json({ error: 'URL não permitida' });
  }
  try {
    const response = await httpsReq(url, {
      rawBuffer: true,
      headers: { 'User-Agent': WEB_UA, 'Referer': 'https://www.instagram.com/' },
    });
    const contentType = response.headers['content-type'] || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(response.body); // Buffer
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/collect', async (req, res) => {
  const token = req.headers['x-session-token'];
  const s = sessions.get(token);
  if (!s) return res.status(401).json({ error: 'Sessão inválida ou expirada' });

  try {
    if (isWebSession(s)) {
      const { userId } = s;
      const effectiveUA = s.ua || WEB_UA;
      const webOnly = true; // Sessão web-login: só usar www.instagram.com
      console.log(`[collect-web] Iniciando coleta para userId=${userId}...`);

      collectionProgress.set(token, { active: true, step: 'init', message: 'Verificando sessão...', pct: 5 });

      // Enriquecer cookies com csrftoken, mid, etc. para evitar useragent mismatch
      console.log('[collect-web] Enriquecendo cookies de sessão...');
      const cookieStr = await enrichWebCookies(s.cookieStr, effectiveUA);
      const ua = effectiveUA;

      collectionProgress.set(token, { active: true, step: 'cookies', message: 'Sessão verificada, preparando coleta...', pct: 12 });

      // current_user pode falhar com sessões web — usar dados da sessão como fallback
      let account = { pk: userId, username: s.username || '', full_name: '', avatar_url: '', followers_count: 0, following_count: 0, posts_count: 0 };
      try {
        const accData = await igGetSafe('/accounts/current_user/?edit=true', cookieStr, ua, webOnly);
        if (accData?.user) account = formatAccount(accData.user);
        console.log(`[collect-web] Conta: @${account.username}`);
      } catch (accErr) {
        console.warn(`[collect-web] current_user falhou (${accErr.message}), usando dados da sessão: @${s.username}`);
      }

      const userLabel = account.username ? `@${account.username}` : `id:${userId}`;
      collectionProgress.set(token, { active: true, step: 'cookies', message: `${userLabel} — buscando dados do perfil...`, pct: 14 });

      // web_profile_info: endpoint do viewer de perfil — retorna contagens reais,
      // independente das friendships (menos suscetível a rate-limit)
      const wpi = await fetchWebProfileInfo(account.username || s.username, cookieStr, ua);
      if (wpi) {
        if (wpi.followers_count > 0) account.followers_count = wpi.followers_count;
        if (wpi.following_count > 0) account.following_count = wpi.following_count;
        if (wpi.posts_count     > 0) account.posts_count     = wpi.posts_count;
        if (!account.avatar_url && wpi.avatar_url) account.avatar_url = wpi.avatar_url;
        console.log(`[collect-web] web_profile_info OK: ${account.followers_count} seg | ${account.following_count} snd | ${account.posts_count} posts`);
      } else {
        console.warn('[collect-web] web_profile_info falhou, contagens podem ser 0');
      }

      // Parseando modo de coleta: ?mode=followers,following,posts  (default = tudo)
      const modeParam = (req.query.mode || 'followers,following,posts').toLowerCase();
      const modes = modeParam.split(',').map(m => m.trim());
      const doFollowers = modes.includes('followers');
      const doFollowing = modes.includes('following');
      const doPosts     = modes.includes('posts');
      console.log(`[collect-web] Modo: followers=${doFollowers} following=${doFollowing} posts=${doPosts}`);

      collectionProgress.set(token, { active: true, step: 'cookies', message: `${userLabel} — ${account.followers_count} seg, ${account.following_count} snd. Iniciando...`, pct: 18 });

      // Delay inicial apenas se houver seções a coletar
      if (doFollowers || doFollowing || doPosts) {
        await sleep(3000 + Math.random() * 3000);
      }

      // ── Seguidores ──────────────────────────────────────────────────────────
      let fr = { items: [], hasMore: false };
      if (doFollowers) {
        collectionProgress.set(token, { active: true, step: 'followers', message: `${userLabel} — coletando seguidores...`, pct: 20 });
        console.log('[collect-web] Buscando seguidores...');
        fr = await webPaginateFeed(
          `/friendships/${userId}/followers/?count=50`, cookieStr, 'users', 10000, ua, webOnly,
          (n, batch) => {
            const names = (batch || []).map(u => u.username).filter(Boolean).slice(0, 5);
            collectionProgress.set(token, { active: true, step: 'followers', message: `${userLabel} — seguidores: ${n} lidos...`, pct: 20 + Math.min(Math.floor(n / 80), 25), latestUsers: names });
          },
          false, /* failFast */
          (n, coolSecs) => {
            collectionProgress.set(token, { active: true, step: 'followers', message: `${userLabel} — ${n} seguidores lidos. Aguardando ${coolSecs}s (anti-rate-limit)...`, pct: 20 + Math.min(Math.floor(n / 80), 25) });
          },
          `${userId}:followers` /* resumeKey */
        );
        console.log(`[collect-web] ${fr.items.length} seguidores`);
        collectionProgress.set(token, { active: true, step: 'followers_done', message: `${userLabel} — ${fr.items.length} seguidores. Continuando...`, pct: 45 });
        if (doFollowing || doPosts) await sleep(5000 + Math.random() * 5000);
      } else {
        collectionProgress.set(token, { active: true, step: 'followers_done', message: `${userLabel} — seguidores ignorados (modo parcial)`, pct: 45 });
      }

      // ── Seguindo ────────────────────────────────────────────────────────────
      let fg = { items: [], hasMore: false };
      if (doFollowing) {
        collectionProgress.set(token, { active: true, step: 'following', message: `${userLabel} — coletando seguindo...`, pct: 50 });
        console.log('[collect-web] Buscando seguindo...');
        fg = await webPaginateFeed(
          `/friendships/${userId}/following/?count=50`, cookieStr, 'users', 10000, ua, webOnly,
          (n, batch) => {
            const names = (batch || []).map(u => u.username).filter(Boolean).slice(0, 5);
            collectionProgress.set(token, { active: true, step: 'following', message: `${userLabel} — seguindo: ${n} lidos...`, pct: 50 + Math.min(Math.floor(n / 80), 23), latestUsers: names });
          },
          false, /* failFast */
          (n, coolSecs) => {
            collectionProgress.set(token, { active: true, step: 'following', message: `${userLabel} — ${n} seguindo lidos. Aguardando ${coolSecs}s (anti-rate-limit)...`, pct: 50 + Math.min(Math.floor(n / 80), 23) });
          },
          `${userId}:following` /* resumeKey */
        );
        console.log(`[collect-web] ${fg.items.length} seguindo`);
        collectionProgress.set(token, { active: true, step: 'following_done', message: `${userLabel} — ${fg.items.length} seguindo. Continuando...`, pct: 76 });
        if (doPosts) await sleep(5000 + Math.random() * 5000);
      } else {
        collectionProgress.set(token, { active: true, step: 'following_done', message: `${userLabel} — seguindo ignorado (modo parcial)`, pct: 76 });
      }

      // ── Posts ────────────────────────────────────────────────────────────────
      let pr = { items: [], hasMore: false };
      if (doPosts) {
        collectionProgress.set(token, { active: true, step: 'posts', message: `${userLabel} — coletando posts...`, pct: 80 });
        console.log('[collect-web] Buscando posts...');
        pr = await webPaginateFeed(
          `/feed/user/${userId}/?count=33`, cookieStr, 'profile_grid_items', 100, ua, webOnly,
          (n) => collectionProgress.set(token, { active: true, step: 'posts', message: `${userLabel} — posts: ${n} lidos...`, pct: 80 + Math.min(n, 12) }),
          true /* failFast */
        );
        console.log(`[collect-web] ${pr.items.length} posts`);
      } else {
        collectionProgress.set(token, { active: true, step: 'posts', message: `${userLabel} — posts ignorados (modo parcial)`, pct: 80 });
      }

      // ── Contagens finais ────────────────────────────────────────────────────
      if (account.followers_count === 0) account.followers_count = fr.items.length;
      if (account.following_count === 0) account.following_count = fg.items.length;

      // Posts: feed paginado tem prioridade; fallback para recentPosts do web_profile_info
      let posts;
      if (pr.items.length > 0) {
        posts = pr.items.map(raw => {
          const p = raw.media || raw;
          return {
            post_id: String(p.id || p.pk || ''),
            caption: p.caption?.text || '',
            media_url: p.image_versions2?.candidates?.[0]?.url || p.carousel_media?.[0]?.image_versions2?.candidates?.[0]?.url || '',
            created_at: (p.taken_at || 0) * 1000,
            likes_count: p.like_count || 0,
            comments_count: p.comment_count || 0,
            likers_list: [],
          };
        });
      } else if (wpi?.recentPosts?.length > 0) {
        console.log(`[collect-web] Posts via web_profile_info: ${wpi.recentPosts.length} itens`);
        posts = wpi.recentPosts;
      } else {
        posts = [];
      }
      if (account.posts_count === 0) account.posts_count = posts.length;

      // ── Curtidas (likers) por post ────────────────────────────────────────────
      if (doPosts && posts.length > 0) {
        collectionProgress.set(token, {
          active: true, step: 'likers',
          message: `${userLabel} — buscando curtidas (0/${posts.length} posts)...`,
          pct: 88,
        });
        let likersOk = 0;
        for (let i = 0; i < posts.length; i++) {
          const post = posts[i];
          const mediaId = post.post_id.split('_')[0]; // ID numérico sem userId
          try {
            const likersData = await igGetSafe(`/media/${mediaId}/likers/`, cookieStr, ua, webOnly, 1, true);
            if (Array.isArray(likersData?.users) && likersData.users.length > 0) {
              post.likers_list = likersData.users.map(u => u.username).filter(Boolean);
              likersOk++;
            }
          } catch (e) {
            console.warn(`[collect-web] likers ${mediaId}: ${e.message}`);
          }
          collectionProgress.set(token, {
            active: true, step: 'likers',
            message: `${userLabel} — curtidas: ${i + 1}/${posts.length} posts lidos...`,
            pct: 88 + Math.round(((i + 1) / posts.length) * 6),
            latestUsers: post.likers_list.length > 0 ? post.likers_list.slice(0, 5) : undefined,
          });
          if (i < posts.length - 1) await sleep(2000 + Math.random() * 2000);
        }
        console.log(`[collect-web] Likers: ${likersOk}/${posts.length} posts com curtidas`);
      }

      // partial: alguma seção selecionada retornou 0
      const partial = (doFollowers && fr.items.length === 0) || (doFollowing && fg.items.length === 0);
      // skipped: seções não selecionadas pelo usuário
      const skipped = [
        ...(!doFollowers ? ['followers'] : []),
        ...(!doFollowing ? ['following'] : []),
        ...(!doPosts     ? ['posts']     : []),
      ];

      collectionProgress.set(token, {
        active: true, step: 'posts_done',
        message: `${userLabel} — ${account.followers_count} seg, ${account.following_count} snd, ${posts.length} posts. Salvando...`,
        pct: 95
      });

      collectionProgress.delete(token);
      return res.json({
        collected_at: Date.now(), account,
        followers: fr.items.map(u => u.username),
        following: fg.items.map(u => u.username),
        posts,
        has_more_followers: fr.hasMore,
        has_more_following: fg.hasMore,
        partial,
        skipped,
      });
    }

    // Native (IgApiClient)
    const ig = s;
    const user = await ig.account.currentUser();
    const info = await ig.user.info(user.pk);
    const [fi, fgi, mi] = await Promise.all([
      paginateFeed(ig.feed.accountFollowers(user.pk), 2000),
      paginateFeed(ig.feed.accountFollowing(user.pk), 2000),
      paginateFeed(ig.feed.user(user.pk), 100),
    ]);
    const posts = mi.map(p => ({
      post_id: String(p.id || p.pk),
      caption: p.caption?.text || '',
      media_url: p.image_versions2?.candidates?.[0]?.url || '',
      created_at: (p.taken_at || 0) * 1000,
      likes_count: p.like_count || 0,
      comments_count: p.comment_count || 0,
      likers_list: [],
    }));
    return res.json({ collected_at: Date.now(), account: formatAccount({ ...user, ...info }), followers: fi.map(u => u.username), following: fgi.map(u => u.username), posts, has_more_followers: fi.length >= 2000, has_more_following: fgi.length >= 2000 });
  } catch (err) {
    collectionProgress.delete(token);
    console.error('[collect]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Coleta de perfil monitorado (outra conta) ────────────────────────── */
app.get('/api/collect-monitored', async (req, res) => {
  const token = req.headers['x-session-token'];
  const s = sessions.get(token);
  if (!s) return res.status(401).json({ error: 'Sessão inválida ou expirada' });

  const targetUsername = (req.query.username || '').replace('@', '').trim().toLowerCase();
  if (!targetUsername) return res.status(400).json({ error: 'username obrigatório' });

  if (!isWebSession(s)) {
    return res.status(400).json({ error: 'Coleta de perfil monitorado requer sessão web' });
  }

  try {
    const effectiveUA = s.ua || WEB_UA;
    const webOnly = true;
    const modeParam = (req.query.mode || 'followers,following,posts').toLowerCase();
    const modes = modeParam.split(',').map(m => m.trim());
    const doFollowers = modes.includes('followers');
    const doFollowing = modes.includes('following');
    const doPosts     = modes.includes('posts');

    console.log(`[collect-monitored] @${targetUsername} mode=${modeParam}`);
    collectionProgress.set(token, { active: true, step: 'init', message: `@${targetUsername} — resolvendo perfil...`, pct: 5 });

    const cookieStr = await enrichWebCookies(s.cookieStr, effectiveUA);

    // 1. Resolver o user_id do perfil alvo
    console.log(`[collect-monitored] buscando perfil de @${targetUsername}...`);
    const profileData = await fetchProfileFromHTML(targetUsername, cookieStr, effectiveUA);
    if (!profileData) {
      collectionProgress.delete(token);
      return res.status(404).json({ error: `Perfil @${targetUsername} não encontrado ou inacessível` });
    }

    const targetUserId = profileData.user_id;
    if (!targetUserId) {
      console.warn(`[collect-monitored] @${targetUsername}: user_id não encontrado no HTML`);
      // Retornar apenas dados de perfil sem listas completas
      collectionProgress.delete(token);
      return res.json({
        collected_at: Date.now(),
        account: {
          pk: '',
          username: targetUsername,
          full_name: '',
          avatar_url: profileData.avatar_url || '',
          followers_count: profileData.followers_count || 0,
          following_count: profileData.following_count || 0,
          posts_count: profileData.posts_count || 0,
        },
        followers: [],
        following: [],
        posts: [],
        has_more_followers: false,
        has_more_following: false,
        partial: true,
        skipped: ['followers', 'following', 'posts'],
        error_detail: 'user_id não encontrado — apenas contagens disponíveis',
      });
    }

    console.log(`[collect-monitored] @${targetUsername} user_id=${targetUserId} seguidores=${profileData.followers_count}`);
    collectionProgress.set(token, {
      active: true, step: 'profile',
      message: `@${targetUsername} — ${profileData.followers_count} seg, ${profileData.following_count} snd. Iniciando coleta...`,
      pct: 15
    });

    await sleep(2000 + Math.random() * 2000);

    // 2. Seguidores
    let fr = { items: [], hasMore: false };
    if (doFollowers) {
      collectionProgress.set(token, { active: true, step: 'followers', message: `@${targetUsername} — coletando seguidores...`, pct: 20 });
      console.log(`[collect-monitored] buscando seguidores de @${targetUsername} (id=${targetUserId})...`);
      fr = await webPaginateFeed(
        `/friendships/${targetUserId}/followers/?count=50`, cookieStr, 'users', 10000, effectiveUA, webOnly,
        (n) => collectionProgress.set(token, { active: true, step: 'followers', message: `@${targetUsername} — seguidores: ${n} lidos...`, pct: 20 + Math.min(Math.floor(n / 80), 25) }),
        false,
        null,
        `mon:${targetUserId}:followers`
      );
      console.log(`[collect-monitored] ${fr.items.length} seguidores de @${targetUsername}`);
      collectionProgress.set(token, { active: true, step: 'followers_done', message: `@${targetUsername} — ${fr.items.length} seguidores. Continuando...`, pct: 45 });
      if (doFollowing || doPosts) await sleep(4000 + Math.random() * 4000);
    }

    // 3. Seguindo
    let fg = { items: [], hasMore: false };
    if (doFollowing) {
      collectionProgress.set(token, { active: true, step: 'following', message: `@${targetUsername} — coletando seguindo...`, pct: 50 });
      console.log(`[collect-monitored] buscando seguindo de @${targetUsername} (id=${targetUserId})...`);
      fg = await webPaginateFeed(
        `/friendships/${targetUserId}/following/?count=50`, cookieStr, 'users', 10000, effectiveUA, webOnly,
        (n) => collectionProgress.set(token, { active: true, step: 'following', message: `@${targetUsername} — seguindo: ${n} lidos...`, pct: 50 + Math.min(Math.floor(n / 80), 23) }),
        false,
        null,
        `mon:${targetUserId}:following`
      );
      console.log(`[collect-monitored] ${fg.items.length} seguindo de @${targetUsername}`);
      collectionProgress.set(token, { active: true, step: 'following_done', message: `@${targetUsername} — ${fg.items.length} seguindo. Continuando...`, pct: 76 });
      if (doPosts) await sleep(4000 + Math.random() * 4000);
    }

    // 4. Posts
    let pr = { items: [], hasMore: false };
    if (doPosts) {
      collectionProgress.set(token, { active: true, step: 'posts', message: `@${targetUsername} — coletando posts...`, pct: 80 });
      console.log(`[collect-monitored] buscando posts de @${targetUsername} (id=${targetUserId})...`);
      pr = await webPaginateFeed(
        `/feed/user/${targetUserId}/?count=33`, cookieStr, 'profile_grid_items', 100, effectiveUA, webOnly,
        (n) => collectionProgress.set(token, { active: true, step: 'posts', message: `@${targetUsername} — posts: ${n} lidos...`, pct: 80 + Math.min(n, 12) }),
        true
      );
      console.log(`[collect-monitored] ${pr.items.length} posts de @${targetUsername}`);
    }

    const posts = pr.items.map(raw => {
      const p = raw.media || raw;
      return {
        post_id: String(p.id || p.pk || ''),
        caption: p.caption?.text || '',
        media_url: p.image_versions2?.candidates?.[0]?.url || p.carousel_media?.[0]?.image_versions2?.candidates?.[0]?.url || '',
        created_at: (p.taken_at || 0) * 1000,
        likes_count: p.like_count || 0,
        comments_count: p.comment_count || 0,
        likers_list: [],
      };
    });

    // 5. Curtidas por post
    if (doPosts && posts.length > 0) {
      collectionProgress.set(token, { active: true, step: 'likers', message: `@${targetUsername} — buscando curtidas (0/${posts.length} posts)...`, pct: 88 });
      let likersOk = 0;
      for (let i = 0; i < posts.length; i++) {
        const post = posts[i];
        const mediaId = post.post_id.split('_')[0];
        try {
          const likersData = await igGetSafe(`/media/${mediaId}/likers/`, cookieStr, effectiveUA, webOnly, 1, true);
          if (Array.isArray(likersData?.users) && likersData.users.length > 0) {
            post.likers_list = likersData.users.map(u => u.username).filter(Boolean);
            likersOk++;
          }
        } catch (e) {
          console.warn(`[collect-monitored] likers ${mediaId}: ${e.message}`);
        }
        collectionProgress.set(token, { active: true, step: 'likers', message: `@${targetUsername} — curtidas: ${i + 1}/${posts.length} posts...`, pct: 88 + Math.round(((i + 1) / posts.length) * 6) });
        if (i < posts.length - 1) await sleep(2000 + Math.random() * 2000);
      }
      console.log(`[collect-monitored] Likers: ${likersOk}/${posts.length} posts`);
    }

    const partial = (doFollowers && fr.items.length === 0) || (doFollowing && fg.items.length === 0);
    const skipped = [
      ...(!doFollowers ? ['followers'] : []),
      ...(!doFollowing ? ['following'] : []),
      ...(!doPosts     ? ['posts']     : []),
    ];

    collectionProgress.delete(token);
    return res.json({
      collected_at: Date.now(),
      account: {
        pk: String(targetUserId),
        username: targetUsername,
        full_name: '',
        avatar_url: profileData.avatar_url || '',
        followers_count: profileData.followers_count || fr.items.length,
        following_count: profileData.following_count || fg.items.length,
        posts_count: profileData.posts_count || posts.length,
      },
      followers: fr.items.map(u => u.username),
      following: fg.items.map(u => u.username),
      posts,
      has_more_followers: fr.hasMore,
      has_more_following: fg.hasMore,
      partial,
      skipped,
    });
  } catch (err) {
    collectionProgress.delete(token);
    console.error('[collect-monitored]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Diagnóstico de sessão/perfil (debug) ─────────────────────────────── */
app.get('/api/debug-profile/:username', async (req, res) => {
  const token = req.headers['x-session-token'];
  const s = sessions.get(token);
  if (!s) return res.status(401).json({ error: 'Sessão inválida', sessions_count: sessions.size });

  const username = (req.params.username || '').replace('@','').trim().toLowerCase();
  const cookieStr = await enrichWebCookies(s.cookieStr, s.ua || WEB_UA);
  const ua = s.ua || WEB_UA;
  const results = {};

  // Teste 1: web_profile_info
  try {
    const d = await igGet(`/users/web_profile_info/?username=${encodeURIComponent(username)}`, cookieStr, ua, true);
    results.web_profile_info = { ok: true, keys: Object.keys(d || {}), user_keys: Object.keys(d?.data?.user || d?.user || {}), has_avatar: !!(d?.data?.user?.profile_pic_url || d?.user?.profile_pic_url) };
  } catch(e) { results.web_profile_info = { ok: false, error: e.message }; }

  // Teste 2: by/username
  try {
    const d = await igGet(`/users/by/username/${encodeURIComponent(username)}/`, cookieStr, ua, false);
    results.by_username = { ok: true, username: d?.user?.username, follower_count: d?.user?.follower_count };
  } catch(e) { results.by_username = { ok: false, error: e.message }; }

  // Teste 3: usernameinfo
  try {
    const d = await igGet(`/users/${encodeURIComponent(username)}/usernameinfo/`, cookieStr, ua, false);
    results.usernameinfo = { ok: true, username: d?.user?.username, follower_count: d?.user?.follower_count };
  } catch(e) { results.usernameinfo = { ok: false, error: e.message }; }

  // Teste 4: search
  try {
    const d = await igGet(`/users/search/?q=${encodeURIComponent(username)}&count=3`, cookieStr, ua, true);
    results.search = { ok: true, count: d?.users?.length || 0, first: d?.users?.[0]?.username };
  } catch(e) { results.search = { ok: false, error: e.message }; }

  // Info da sessão
  results.session_info = { type: s.type, has_cookies: !!s.cookieStr, cookies_keys: s.cookieStr ? s.cookieStr.split(';').map(c => c.trim().split('=')[0]).join(', ') : 'none' };

  res.json(results);
});

/* ── Logout ──────────────────────────────────────────────────────────────── */
app.delete('/api/auth/session', (req, res) => {
  const token = req.headers['x-session-token'];
  if (token) sessions.delete(token);
  res.json({ ok: true });
});

/* ── Start ───────────────────────────────────────────────────────────────── */
app.listen(PORT, () => {
  // Limpa log anterior ao iniciar
  try { fs.writeFileSync(LOG_FILE, `=== Server started ${new Date().toISOString()} ===\n`); } catch {}
  console.log('══════════════════════════════════════════════');
  console.log(`  ✅ InstaMonitor Backend — http://localhost:${PORT}`);
  console.log('  Login com senha  → POST /api/auth/login');
  console.log('  Login Session ID → POST /api/auth/cookie-login');
  console.log('══════════════════════════════════════════════');
});

/* ── Rota de logs (diagnóstico) ──────────────────────────────────────────── */
app.get('/api/logs', (_req, res) => {
  try {
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = content.split('\n');
    const tail = lines.slice(-200).join('\n');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(tail);
  } catch (e) {
    res.send('Sem logs disponíveis: ' + e.message);
  }
});
