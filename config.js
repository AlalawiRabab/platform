const SUPABASE_URL = "https://qeabgktifyyyjrzphtpw.supabase.co";

const SUPABASE_ANON_KEY = "sb_publishable_G3EvrlPIwhYfrnauHQDveA_bW4YpVwl";

const supabaseClient = supabase.createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY
);
