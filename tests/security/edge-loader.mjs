const MOCK = new URL('./supabase-mock.mjs', import.meta.url).href;
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('https://esm.sh/@supabase/supabase-js')) return { url: MOCK, shortCircuit: true };
  return next(spec, ctx);
}
