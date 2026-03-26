const express = require('express');
const cors = require('cors');
const https = require('https');
const { URL } = require('url');
const { IgApiClient, IgCheckpointError, IgLoginTwoFactorRequiredError } = require('instagram-private-api');
const { v4: uuid } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const PORT = 3001;

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
 * Busca dados do perfil via web_profile_info — menos sujeito a rate-limit
 * que os endpoints de friendships. Retorna contagens reais e até 12 posts.
 */
async function fetchWebProfileInfo(username, cookieStr, ua) {
  if (!username) return null;
  try {
    const data = await igGet(`/users/web_profile_info/?username=${encodeURIComponent(username)}`, cookieStr, ua, true);
    // Suporta ambos os formatos: data.data.user e data.user
    const u = data?.data?.user || data?.user;
    if (!u) {
      console.warn('[fetchWebProfileInfo] Sem dados de usuário. Keys:', Object.keys(data || {}).join(', '));
      return null;
    }
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
      followers_count: u.edge_followed_by?.count || u.follower_count || 0,
      following_count: u.edge_follow?.count    || u.following_count  || 0,
      posts_count:     u.edge_owner_to_timeline_media?.count || u.media_count || recentPosts.length,
      avatar_url:      u.profile_pic_url_hd || u.hd_profile_pic_url_info?.url || u.profile_pic_url || '',
      recentPosts,
    };
  } catch (e) {
    console.warn('[fetchWebProfileInfo] Erro:', e.message);
    return null;
  }
}

function isWebSession(s) { return s && s.type === 'web'; }

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
    const cookieStr = s.cookieStr;
    const ua = s.ua || WEB_UA;
    let foundUserId = null;
    let foundAvatarUrl = '';

    // Tentativa 1: web_profile_info (retorna dados completos incluindo perfis privados que você segue)
    const wpi = await fetchWebProfileInfo(username, cookieStr, ua);
    if (wpi) {
      console.log(`[profile] @${username} via web_profile_info OK (seg=${wpi.followers_count} snd=${wpi.following_count} posts=${wpi.posts_count} avatar=${!!wpi.avatar_url})`);
      return res.json({
        username,
        avatar_url: wpi.avatar_url || '',
        followers_count: wpi.followers_count,
        following_count: wpi.following_count,
        posts_count: wpi.posts_count,
      });
    }
    console.warn(`[profile] web_profile_info falhou para @${username} — tentando by/username...`);

    // Tentativa 2: by/username via API mobile (funciona para privados que você segue)
    try {
      console.log(`[profile] Tentando by/username para @${username}...`);
      const byData = await igGetSafe(
        `/users/by/username/${encodeURIComponent(username)}/`,
        cookieStr, ua, false, 1, true
      );
      const ub = byData?.user;
      if (ub?.username) {
        console.log(`[profile] @${username} via by/username OK`);
        return res.json({
          username: ub.username || username,
          avatar_url: ub.profile_pic_url_hd || ub.hd_profile_pic_url_info?.url || ub.profile_pic_url || '',
          followers_count: ub.follower_count || 0,
          following_count: ub.following_count || 0,
          posts_count: ub.media_count || 0,
        });
      }
    } catch (byErr) {
      console.warn(`[profile] by/username falhou: ${byErr.message}`);
    }

    // Tentativa 3: user search → obtém user_id
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

    // Tentativa 4: /api/v1/users/{id}/info/ via i.instagram.com (funciona para seguidos privados)
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

    // Tentativa 5: username info endpoint (variante web)
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

/* ── Logout ──────────────────────────────────────────────────────────────── */
app.delete('/api/auth/session', (req, res) => {
  const token = req.headers['x-session-token'];
  if (token) sessions.delete(token);
  res.json({ ok: true });
});

/* ── Start ───────────────────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log('══════════════════════════════════════════════');
  console.log(`  ✅ InstaMonitor Backend — http://localhost:${PORT}`);
  console.log('  Login com senha  → POST /api/auth/login');
  console.log('  Login Session ID → POST /api/auth/cookie-login');
  console.log('══════════════════════════════════════════════');
});
