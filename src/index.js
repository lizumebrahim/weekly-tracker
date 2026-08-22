import { createClient } from '@supabase/supabase-js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Auth endpoints
    if (url.pathname === '/api/auth/callback' && request.method === 'GET') {
      return handleAuthCallback(request, env);
    }

    // Protected endpoints - require authentication
    if (url.pathname === '/api/transactions' && request.method === 'GET') {
      return handleProtectedRequest(request, env, () => handleGetTransactions(env));
    }
    if (url.pathname === '/api/receipts/upload' && request.method === 'POST') {
      return handleProtectedRequest(request, env, () => handleUpload(request, env));
    }

    return env.ASSETS.fetch(request);
  },
};

// Verify JWT token from Supabase
async function verifyToken(token, env) {
  if (!token) return null;

  try {
    // Remove 'Bearer ' prefix if present
    const jwtToken = token.replace('Bearer ', '');
    
    // Call Supabase to verify the token
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
    const { data: { user }, error } = await supabase.auth.getUser(jwtToken);
    
    if (error || !user) return null;
    return user;
  } catch (error) {
    console.error('Token verification error:', error);
    return null;
  }
}

// Protect endpoints that require authentication
async function handleProtectedRequest(request, env, handler) {
  const authHeader = request.headers.get('Authorization');
  const user = await verifyToken(authHeader, env);

  if (!user) {
    return json({ error: 'Unauthorized' }, 401);
  }

  // Pass user info to handler
  return handler(user);
}

async function handleGetTransactions(env, user) {
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('user_id', user?.id)
    .order('transaction_date', { ascending: false, nullsFirst: false });
  
  if (error) return json({ error: error.message }, 500);
  return json(data);
}

async function handleAuthCallback(request, env) {
  // Handle OAuth callback from Supabase
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  
  if (!code) {
    return json({ error: 'No auth code provided' }, 400);
  }

  try {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_KEY);
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) throw error;

    // Redirect back to app with session
    return new Response(null, {
      status: 302,
      headers: {
        'Location': '/',
        'Set-Cookie': `auth_token=${data.session.access_token}; Path=/; HttpOnly; Secure; SameSite=Lax`
      }
    });
  } catch (error) {
    console.error('Auth callback error:', error);
    return json({ error: 'Authentication failed' }, 400);
  }
}

async function handleUpload(request, env, user) {
  const token = request.headers.get('x-upload-token');
  if (!token || token !== env.UPLOAD_TOKEN) return json({ error: 'unauthorized' }, 401);

  const formData = await request.formData();
  const file = formData.get('image');
  if (!file) return json({ error: 'no image provided' }, 400);

  const bytes = new Uint8Array(await file.arrayBuffer());

  const result = await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
    image: Array.from(bytes),
    prompt: `This is a Bank of Maldives (BML) transfer receipt screenshot.
If it is NOT a BML receipt, respond with exactly: {"is_bml_receipt": false}
Otherwise extract these fields and respond with ONLY valid JSON, no markdown, no preamble:
{
  "is_bml_receipt": true,
  "amount": <number>,
  "currency": "<string, e.g. MVR>",
  "recipient_name": "<string, the 'To' name>",
  "recipient_account": "<string, the 'To' account number, or null>",
  "reference": "<string>",
  "transaction_date": "<ISO 8601 string, best guess from the date shown>"
}`,
    max_tokens: 512,
  });

  const raw = result.response ?? '{}';
  let parsed;
  try {
    parsed = JSON.parse(raw.trim().replace(/^```json|```$/g, '').trim());
  } catch {
    return json({ error: 'could not parse receipt', raw }, 422);
  }

  if (!parsed.is_bml_receipt) return json({ skipped: true, reason: 'not a BML receipt' });

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  const { data, error } = await supabase
    .from('transactions')
    .insert({
      user_id: user?.id,
      amount: parsed.amount,
      currency: parsed.currency || 'MVR',
      recipient_name: parsed.recipient_name ?? null,
      recipient_account: parsed.recipient_account ?? null,
      reference: parsed.reference ?? null,
      transaction_date: parsed.transaction_date ?? null,
    })
    .select()
    .single();

  if (error) return json({ error: error.message }, 500);
  return json({ saved: true, transaction: data });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
