// ===================
// Monday.com API Client
// ===================

// Board: 18393063747 (Incoming Calls)
// Column IDs:
//   name              - Item name (caller phone)
//   phone_mkyxe5hs    - Caller Phone
//   date_mkyxac2p     - Incoming Date & Time
//   status            - Call Status (0=RINGING, 1=ANSWERED, 2=MISSED, 4=ENDED)
//   color_mkz5s61c    - Call Queue (3=MAIN, 0=OVERFLOW, 2=ANSWERING SERVICE)
//   text_mkyxbg9c     - Source (from call)
//   phone_mkyxcxzk    - Number Called
//   text_mkyxh5fw     - Zoom Call ID

export const MONDAY_BOARD_ID = '18393063747';
export const MONDAY_WORKSPACE = 'roofbuddy';

export function getMondayItemUrl(itemId: string): string {
  return `https://${MONDAY_WORKSPACE}.monday.com/boards/${MONDAY_BOARD_ID}/pulses/${itemId}`;
}

export const MONDAY_COLUMNS = {
  CALLER_PHONE: 'phone_mkyxe5hs',
  INCOMING_DATE: 'date_mkyxac2p',
  CALL_STATUS: 'status',
  CALL_QUEUE: 'color_mkz5s61c',
  SOURCE: 'text_mkyxbg9c',
  NUMBER_CALLED: 'phone_mkyxcxzk',
  ZOOM_CALL_ID: 'text_mkyxh5fw',
  ACTION_CALL: 'link_mkyzpy9v',
} as const;

// Status column label indices (from Monday board)
export const STATUS_LABELS = {
  RINGING: '0',
  ANSWERED: '1',
  MISSED: '2',
  IN_PROGRESS: '3',
  ENDED: '4',
  WEB: '6',
} as const;

// Call Queue (color) column label indices
export const QUEUE_LABELS = {
  MAIN: '3',
  OVERFLOW: '0',
  ANSWERING_SERVICE: '2',
} as const;

export interface MondayItemInput {
  callerPhone: string;
  callerName?: string;
  incomingDateIso: string;
  callStatus: keyof typeof STATUS_LABELS;
  callQueue: keyof typeof QUEUE_LABELS;
  source?: string;
  numberCalled?: string;
  zoomCallId: string;
}

interface MondayCreateResponse {
  data?: {
    create_item?: {
      id: string;
    };
  };
  errors?: Array<{ message: string }>;
}

interface MondayUpdateResponse {
  data?: {
    change_multiple_column_values?: {
      id: string;
    };
  };
  errors?: Array<{ message: string }>;
}

interface MondayItemResponse {
  data?: {
    items?: Array<{
      id: string;
      column_values?: Array<{
        id: string;
        value: string | null;
        text: string | null;
      }>;
    }>;
  };
  errors?: Array<{ message: string }>;
}

export async function getMondayItemActionCallUrl(
  apiToken: string,
  itemId: string
): Promise<string | undefined> {
  const query = `
    query GetItem($itemId: ID!) {
      items(ids: [$itemId]) {
        id
        column_values(ids: ["${MONDAY_COLUMNS.ACTION_CALL}"]) {
          id
          value
          text
        }
      }
    }
  `;

  const response = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiToken,
    },
    body: JSON.stringify({
      query,
      variables: { itemId },
    }),
  });

  if (!response.ok) {
    throw new Error(`Monday API error: ${response.status} ${response.statusText}`);
  }

  const result = (await response.json()) as MondayItemResponse;

  if (result.errors?.length) {
    throw new Error(`Monday GraphQL error: ${result.errors.map((e) => e.message).join(', ')}`);
  }

  const item = result.data?.items?.[0];
  const actionCallColumn = item?.column_values?.find((col) => col.id === MONDAY_COLUMNS.ACTION_CALL);

  if (actionCallColumn?.value) {
    try {
      // Link column value is JSON: {"url": "...", "text": "..."}
      const linkData = JSON.parse(actionCallColumn.value) as { url?: string; text?: string };
      return linkData.url;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

export async function updateMondayItemStatus(
  apiToken: string,
  itemId: string,
  status: keyof typeof STATUS_LABELS,
  queue?: keyof typeof QUEUE_LABELS
): Promise<void> {
  const columnValues: Record<string, unknown> = {
    [MONDAY_COLUMNS.CALL_STATUS]: { index: parseInt(STATUS_LABELS[status], 10) },
  };

  // Also update queue if provided (for when call overflows)
  if (queue) {
    columnValues[MONDAY_COLUMNS.CALL_QUEUE] = { index: parseInt(QUEUE_LABELS[queue], 10) };
  }

  const query = `
    mutation UpdateItem($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
      change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $columnValues) {
        id
      }
    }
  `;

  const response = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiToken,
    },
    body: JSON.stringify({
      query,
      variables: {
        boardId: MONDAY_BOARD_ID,
        itemId,
        columnValues: JSON.stringify(columnValues),
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Monday API error: ${response.status} ${response.statusText}`);
  }

  const result = (await response.json()) as MondayUpdateResponse;

  if (result.errors?.length) {
    throw new Error(`Monday GraphQL error: ${result.errors.map((e) => e.message).join(', ')}`);
  }
}

export async function createMondayItem(
  apiToken: string,
  input: MondayItemInput
): Promise<string> {
  const itemName = input.callerPhone;

  // Build column values JSON
  const columnValues: Record<string, unknown> = {
    [MONDAY_COLUMNS.CALLER_PHONE]: { phone: input.callerPhone, countryShortName: 'US' },
    [MONDAY_COLUMNS.INCOMING_DATE]: { date: input.incomingDateIso.split('T')[0], time: input.incomingDateIso.split('T')[1]?.substring(0, 8) },
    [MONDAY_COLUMNS.CALL_STATUS]: { index: parseInt(STATUS_LABELS[input.callStatus], 10) },
    [MONDAY_COLUMNS.CALL_QUEUE]: { index: parseInt(QUEUE_LABELS[input.callQueue], 10) },
    [MONDAY_COLUMNS.ZOOM_CALL_ID]: input.zoomCallId,
  };

  if (input.source) {
    columnValues[MONDAY_COLUMNS.SOURCE] = input.source;
  }

  if (input.numberCalled) {
    columnValues[MONDAY_COLUMNS.NUMBER_CALLED] = { phone: input.numberCalled, countryShortName: 'US' };
  }

  const query = `
    mutation CreateItem($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
      create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues) {
        id
      }
    }
  `;

  const response = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiToken,
    },
    body: JSON.stringify({
      query,
      variables: {
        boardId: MONDAY_BOARD_ID,
        itemName,
        columnValues: JSON.stringify(columnValues),
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Monday API error: ${response.status} ${response.statusText}`);
  }

  const result = (await response.json()) as MondayCreateResponse;

  if (result.errors?.length) {
    throw new Error(`Monday GraphQL error: ${result.errors.map((e) => e.message).join(', ')}`);
  }

  const itemId = result.data?.create_item?.id;
  if (!itemId) {
    throw new Error('Monday API did not return item ID');
  }

  return itemId;
}
