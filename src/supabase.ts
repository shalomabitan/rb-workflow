import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Using any for database type - generate proper types with:
// npx supabase gen types typescript --project-id <your-project-id> > src/database.types.ts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Database = any;

let supabaseClient: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (!supabaseClient) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set');
    }

    supabaseClient = createClient(supabaseUrl, supabaseKey, {
      auth: {
        // Disable for serverless - no persistent storage available
        persistSession: false,
        // Disable auto refresh - we use service key, not user tokens
        autoRefreshToken: false,
        // Not in browser, no URL to detect
        detectSessionInUrl: false,
      },
    });
  }
  return supabaseClient;
}

export type SupabaseClientType = SupabaseClient;
