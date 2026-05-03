// ── Supabase Client ──────────────────────────────────────────
const SUPABASE_URL  = 'https://mcrhlwqmeccighmxmccz.supabase.co';
const SUPABASE_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1jcmhsd3FtZWNjaWdobXhtY2N6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxODMwNzAsImV4cCI6MjA5Mjc1OTA3MH0.XBe3IxqnI3TLMNF05UyA_kuo0EnQP7zWdQeGKltmXys';

const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
