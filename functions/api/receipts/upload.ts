import { createClient } from '@supabase/supabase-js';

interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  UPLOAD_TOKEN: string;
  ANTHROPIC_API_KEY: string;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  const token = request.headers.get('x-upload-token');
  if (!token || token !== env.UPLOAD_TOKEN) {
    return json({ error: 'unauthorized' }, 401);
  }

  const formData = await request.formData();
  const file = formData.get('image') as File | null;
  if (!file) {
    return json({ error: 'no image provided' }, 400);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const base64 = btoa(String.fromCharCode(...bytes));
  const mediaType = file.type || 'image/png';

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            {
              type: 'text',
              text: `This is a Bank of Maldives (BML) transfer receipt screenshot.
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
            },
          ],
        },
      ],
    }),
  });

  if (!claudeRes.ok) {
    const errText = await claudeRes.text();
    return json({ error: 'claude api error', detail: errText }, 502);
  }

  const claudeData: any = await claudeRes.json();
  const textBlock = claudeData.content?.find((b: any) => b.type === 'text');
  const raw: string = textBlock?.text ?? '{}';

  let parsed: any;
  try {
    parsed = JSON.parse(raw.trim().replace(/^```json|```$/g, '').trim());
  } catch {
    return json({ error: 'could not parse receipt', raw }, 422);
  }

  if (!parsed.is_bml_receipt) {
    return json({ skipped: true, reason: 'not a BML receipt' });
  }

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

  if (error) {
    return json({ error: error.message }, 500);
  }

  return json({ saved: true, transaction: data });
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
