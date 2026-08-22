import { createClient } from '@supabase/supabase-js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/transactions' && request.method === 'GET') {
      return handleGetTransactions(env);
    }
    if (url.pathname === '/api/receipts/upload' && request.method === 'POST') {
      return handleUpload(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleGetTransactions(env) {
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .order('transaction_date', { ascending: false, nullsFirst: false });
  if (error) return json({ error: error.message }, 500);
  return json(data);
}

async function handleUpload(request, env) {
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
