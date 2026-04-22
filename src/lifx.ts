// ===================
// LIFX Bulb Control
// ===================
//
// Call-center ringing indicator: solid red while a MAIN-queue call is
// ringing, off otherwise. PUTs to /state are idempotent — repeat calls on
// the same state are no-ops from the caller's perspective.

const LIFX_API_BASE = 'https://api.lifx.com/v1';

async function putBulbState(
  token: string,
  label: string,
  formBody: string
): Promise<void> {
  const url = `${LIFX_API_BASE}/lights/label:${encodeURIComponent(label)}/state`;

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formBody,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`LIFX API error: ${response.status} ${response.statusText} ${text}`);
  }
}

export async function lightBulbRed(token: string, label: string): Promise<void> {
  await putBulbState(token, label, 'power=on&color=red&brightness=1.0');
}

export async function turnBulbOff(token: string, label: string): Promise<void> {
  await putBulbState(token, label, 'power=off');
}
