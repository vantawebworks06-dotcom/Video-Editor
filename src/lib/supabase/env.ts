// Public Supabase config. These values are safe in the browser; access control
// is enforced by Row Level Security in the database.
// NEXT_PUBLIC_* vars must be referenced literally so Next.js can inline them.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export function getSupabaseEnv() {
  if (!url || !anonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. " +
        "Copy .env.example to .env.local (or set them in Vercel).",
    );
  }
  return { url, anonKey };
}
