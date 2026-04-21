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
  // Call analytics columns
  WAIT_TIME: 'numeric_mm02wdcz',
  TALK_TIME: 'numeric_mm02tc86',
  ANSWERED_BY: 'text_mm02rp36',
  AGENTS_RANG: 'numeric_mm023pqc',
  IS_OVERFLOW: 'boolean_mm021z5b',
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

async function changeMultipleColumnValues(
  apiToken: string,
  itemId: string,
  columnValues: Record<string, unknown>
): Promise<void> {
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

export async function updateMondayItemStatus(
  apiToken: string,
  itemId: string,
  status: keyof typeof STATUS_LABELS,
  queue?: keyof typeof QUEUE_LABELS
): Promise<void> {
  const columnValues: Record<string, unknown> = {
    [MONDAY_COLUMNS.CALL_STATUS]: { index: parseInt(STATUS_LABELS[status], 10) },
  };

  if (queue) {
    columnValues[MONDAY_COLUMNS.CALL_QUEUE] = { index: parseInt(QUEUE_LABELS[queue], 10) };
  }

  await changeMultipleColumnValues(apiToken, itemId, columnValues);
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

// ===================
// Call Summary Types
// ===================

export interface CallSummary {
  waitSecs: number;
  talkSecs: number;
  answeredBy?: string;
  agentsRang: number;
  isOverflow: boolean;
  // Terminal status to stamp on the board now that the call is fully completed.
  // Needed because Zoom's per-extension events can disagree with the truth
  // (e.g. overflow answered by an external cell shows as MISSED).
  finalStatus: keyof typeof STATUS_LABELS;
}

export async function updateMondayCallSummary(
  apiToken: string,
  itemId: string,
  summary: CallSummary
): Promise<void> {
  const columnValues: Record<string, unknown> = {
    [MONDAY_COLUMNS.WAIT_TIME]: String(summary.waitSecs),
    [MONDAY_COLUMNS.TALK_TIME]: String(summary.talkSecs),
    [MONDAY_COLUMNS.AGENTS_RANG]: String(summary.agentsRang),
    [MONDAY_COLUMNS.IS_OVERFLOW]: { checked: summary.isOverflow },
    [MONDAY_COLUMNS.CALL_STATUS]: { index: parseInt(STATUS_LABELS[summary.finalStatus], 10) },
  };

  if (summary.answeredBy) {
    columnValues[MONDAY_COLUMNS.ANSWERED_BY] = summary.answeredBy;
  }

  await changeMultipleColumnValues(apiToken, itemId, columnValues);
}
