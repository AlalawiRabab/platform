/**
 * PGlite: live-like schema/policies/ACLs + the two new migrations.
 * - phase_evidence_attribution_review.sql   (teacher name, Drive link label, https — new rows only)
 * - phase_security_grants_hardening_review.sql (TRUNCATE/REFERENCES/TRIGGER, anon, trigger functions)
 * No network, no production access.
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { REPO, U, Y_ACTIVE, buildBaseline, applyMigration as applyIndicatorGuard, makeHelpers } from '../indicators/sql-test.mjs';

export const ATTRIBUTION = 'phase_evidence_attribution_review.sql';
export const STRICT = 'phase_evidence_attribution_strict_review.sql';
export const GRANDFATHER = 'phase_evidence_attribution_grandfathering_review.sql';
export const GRANTS = 'phase_security_grants_hardening_review.sql';
// git stores LF; a Windows checkout may hold CRLF, which would change md5(prosrc) of the functions
const sqlFile = name => readFileSync(`${REPO}/sql/${name}`, 'utf8').replace(/\r\n/g, '\n');
export const applyAttribution = db => db.exec(sqlFile(ATTRIBUTION));
export const applyStrict = db => db.exec(sqlFile(STRICT));
export const applyGrandfather = db => db.exec(sqlFile(GRANDFATHER));
export const applyGrants = db => db.exec(sqlFile(GRANTS));
export function rollbackBlock(name) {
  const m = [...sqlFile(name).replace(/\r\n/g, '\n').matchAll(/\/\*\s*\n(BEGIN;[\s\S]*?COMMIT;)[\s\S]*?\*\//g)];
  return m[m.length - 1][1];
}
export const ROLLBACK_FILES = {
  [ATTRIBUTION]: 'phase_evidence_attribution_rollback_review.sql',
  [STRICT]: 'phase_evidence_attribution_strict_rollback_review.sql',
  [GRANDFATHER]: 'phase_evidence_attribution_grandfathering_rollback_review.sql',
  [GRANTS]: 'phase_security_grants_hardening_rollback_review.sql',
};
export const rollbackFile = name => sqlFile(ROLLBACK_FILES[name]);

/** Objects/ACLs present on production (read 2026-10-22) that the indicator baseline does not create. */
export async function buildLiveExtras(db) {
  await db.exec(`
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text);

CREATE FUNCTION public.set_evidence_created_by() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.created_by IS NULL THEN NEW.created_by := auth.uid(); END IF;
  IF NEW.created_by IS DISTINCT FROM auth.uid() AND auth.uid() IS NOT NULL THEN NEW.created_by := auth.uid(); END IF;
  IF NEW.created_at IS NULL THEN NEW.created_at := now(); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_set_evidence_created_by BEFORE INSERT ON public.evidences
  FOR EACH ROW EXECUTE FUNCTION public.set_evidence_created_by();

CREATE FUNCTION public.enforce_evidence_requirement_indicator_match() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE req_indicator_id bigint;
BEGIN
  IF NEW.requirement_id IS NULL THEN RETURN NEW; END IF;
  SELECT r.indicator_id INTO req_indicator_id FROM public.evidence_requirements r WHERE r.id = NEW.requirement_id;
  IF req_indicator_id IS NULL THEN RAISE EXCEPTION 'اسم الشاهد المطلوب غير موجود'; END IF;
  IF NEW.indicator_id IS DISTINCT FROM req_indicator_id THEN RAISE EXCEPTION 'indicator_id mismatch'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_enforce_evidence_requirement_indicator_match BEFORE INSERT OR UPDATE ON public.evidences
  FOR EACH ROW EXECUTE FUNCTION public.enforce_evidence_requirement_indicator_match();

CREATE FUNCTION public.set_evidence_requirement_created_by() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN IF NEW.created_by IS NULL THEN NEW.created_by := auth.uid(); END IF; RETURN NEW; END $$;
CREATE TRIGGER trg_set_evidence_requirement_created_by BEFORE INSERT OR UPDATE ON public.evidence_requirements
  FOR EACH ROW EXECUTE FUNCTION public.set_evidence_requirement_created_by();
CREATE FUNCTION public.set_evidence_requirements_updated_at() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
CREATE TRIGGER trg_evidence_requirements_updated_at BEFORE UPDATE ON public.evidence_requirements
  FOR EACH ROW EXECUTE FUNCTION public.set_evidence_requirements_updated_at();
CREATE FUNCTION public.set_profiles_updated_at() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN RETURN NEW; END $$;
CREATE FUNCTION public.rls_auto_enable() RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN END $$;
CREATE FUNCTION public.get_active_school_year() RETURNS SETOF public.school_years LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
  $$ SELECT * FROM public.school_years WHERE is_active AND NOT is_archived LIMIT 1 $$;
CREATE FUNCTION public.list_school_years(p_include_archived boolean DEFAULT true) RETURNS SETOF public.school_years LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
  $$ SELECT * FROM public.school_years WHERE p_include_archived OR NOT is_archived $$;

CREATE TABLE public.initiatives (id bigint PRIMARY KEY, name text, school_year_id uuid);
CREATE TABLE public.settings (id smallint PRIMARY KEY, school_name text);
CREATE TABLE public.teacher_followups (id bigint PRIMARY KEY, teacher_name text, school_year_id uuid);
CREATE TABLE public.tasks (id bigint PRIMARY KEY, name text, school_year_id uuid);
CREATE TABLE public.kpis (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
CREATE TABLE public.reports (id bigint PRIMARY KEY, title text);
CREATE TABLE public.users (id uuid PRIMARY KEY, name text);
ALTER TABLE public.initiatives ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teacher_followups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kpis ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.school_years ENABLE ROW LEVEL SECURITY;
CREATE POLICY reports_deny_all ON public.reports TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY users_deny_all ON public.users TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY profiles_select ON public.profiles FOR SELECT TO authenticated USING (id = auth.uid() OR public.is_admin());
CREATE POLICY sy_select ON public.school_years FOR SELECT TO authenticated USING (true);
COMMENT ON COLUMN public.evidences.file_name IS 'اسم الملف الأصلي كما رفعه المستخدم.';
-- production policy missing from the indicators baseline
CREATE POLICY evidence_requirements_update ON public.evidence_requirements FOR UPDATE TO authenticated
  USING (public.current_app_role() IN ('admin','vice') AND EXISTS (SELECT 1 FROM public.program_indicators pi
    JOIN public.programs pr ON pr.id = pi.program_id
    WHERE pi.id = evidence_requirements.indicator_id AND public.school_year_allows_write(pr.school_year_id)))
  WITH CHECK (public.current_app_role() IN ('admin','vice') AND EXISTS (SELECT 1 FROM public.program_indicators pi
    JOIN public.programs pr ON pr.id = pi.program_id
    WHERE pi.id = evidence_requirements.indicator_id AND public.school_year_allows_write(pr.school_year_id)));

-- table ACLs exactly as production relacl
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
GRANT ALL ON public.evidence_requirements TO anon, authenticated;
GRANT ALL ON public.evidences, public.initiatives, public.programs, public.school_years,
  public.settings, public.teacher_followups TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, MAINTAIN ON public.program_indicators, public.tasks TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.kpis TO authenticated;
GRANT SELECT ON public.profiles TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;

-- function ACLs exactly as production proacl
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.school_year_allows_read(uuid), public.school_year_allows_write(uuid),
  public.school_year_is_active(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.prevent_delete_linked_indicator() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rls_auto_enable(), public.get_active_school_year(), public.list_school_years(boolean) TO PUBLIC;
`);
}

export async function aclSnapshot(db) {
  const rel = (await db.query(`SELECT relname,
      coalesce((SELECT string_agg(x::text, ',' ORDER BY x::text) FROM unnest(relacl) x), '') a
    FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' ORDER BY 1`)).rows;
  const fn = (await db.query(`SELECT p.oid::regprocedure::text f,
      coalesce((SELECT string_agg(x::text, ',' ORDER BY x::text) FROM unnest(p.proacl) x), '') a,
      coalesce(array_to_string(p.proconfig, ','), '') c
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace ORDER BY 1`)).rows;
  return JSON.stringify({ rel, fn });
}

export async function buildAll(db, { attribution = true, grandfather = attribution, strict = attribution, grants = true } = {}) {
  await buildBaseline(db);
  await applyIndicatorGuard(db);
  await buildLiveExtras(db);
  if (attribution) await applyAttribution(db);
  if (grandfather) await applyGrandfather(db);
  if (strict) await applyStrict(db);
  if (grants) await applyGrants(db);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
};
const db = new PGlite();
await buildAll(db, { attribution: false, grants: false });
const { as, tryQ } = makeHelpers(db);
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const R1 = '40000000-0000-0000-0000-000000000001';

await db.exec(`
INSERT INTO public.programs (id, name, resp, school_year_id) VALUES (1, 'برنامج القراءة', 'أ. رباب', '${Y_ACTIVE}');
INSERT INTO public.program_indicators (id, program_id, indicator_text) VALUES (10, 1, 'مؤشر');
INSERT INTO public.evidence_requirements (id, indicator_id, name) VALUES ('${R1}', 10, 'تقرير التنفيذ');
INSERT INTO public.evidences (id, title, program_id, indicator_id, requirement_id, link, school_year_id, created_by, notes)
  VALUES (100, 'تقرير التنفيذ', 1, 10, '${R1}', 'https://drive.google.com/file/d/legacy/view?usp=sharing', '${Y_ACTIVE}', '${U.teacher}', 'ملاحظة قديمة');
INSERT INTO public.evidences (id, title, program_id, indicator_id, requirement_id, file_url, file_name, school_year_id, created_by)
  VALUES (101, 'تقرير التنفيذ', 1, 10, '${R1}', '${U.teacher}/legacy.pdf', 'legacy.pdf', '${Y_ACTIVE}', '${U.teacher}');
INSERT INTO public.evidences (id, title, program_id, indicator_id, link, person, school_year_id, created_by)
  VALUES (102, 'شاهد عام قديم', 1, NULL, 'https://drive.google.com/drive/folders/old', 'أ. منى', '${Y_ACTIVE}', '${U.vice}');
INSERT INTO storage.objects (bucket_id, name) VALUES ('evidences', '${U.teacher}/legacy.pdf');
SELECT setval(pg_get_serial_sequence('public.evidences', 'id'), 200);
`);
await as('admin', () => tryQ(`UPDATE public.evidences SET is_approved = true WHERE id = 101`));
const evidenceSnap = async () => JSON.stringify((await db.query(`SELECT * FROM public.evidences WHERE id < 200 ORDER BY id`)).rows);
const legacyBefore = await evidenceSnap();
const aclBefore = await aclSnapshot(db);
ok('setup: legacy approved file row', (await one(`SELECT is_approved FROM public.evidences WHERE id=101`)).is_approved === true);

console.log('\n== Attribution migration: apply (twice), no data change ==');
try { await applyAttribution(db); ok('attribution migration applied', true); } catch (e) { ok('attribution migration applied', false, e.message); }
try { await applyAttribution(db); ok('attribution migration re-run is idempotent', true); } catch (e) { ok('attribution migration re-run is idempotent', false, e.message); }
ok('legacy rows byte-identical after migration', legacyBefore === await evidenceSnap());
ok('validation function not callable by anon/authenticated',
  !(await one(`SELECT has_function_privilege('authenticated', 'public.validate_evidence_attribution()', 'EXECUTE') v`)).v
  && !(await one(`SELECT has_function_privilege('anon', 'public.validate_evidence_attribution()', 'EXECUTE') v`)).v);

const insertLink = (person, label, link = 'https://drive.google.com/file/d/new/view') => tryQ(
  `INSERT INTO public.evidences (title, program_id, indicator_id, requirement_id, link, file_name, person, school_year_id, created_by)
   VALUES ('تقرير التنفيذ', 1, 10, $1, $2, $3, $4, $5, $6) RETURNING id, person, file_name, link`,
  [R1, link, label, person, Y_ACTIVE, U.teacher]);
const insertFile = (person, name = 'report.pdf') => tryQ(
  `INSERT INTO public.evidences (title, program_id, indicator_id, requirement_id, file_url, file_name, person, school_year_id, created_by)
   VALUES ('تقرير التنفيذ', 1, 10, $1, $2, $3, $4, $5, $6) RETURNING id, person, file_name`,
  [R1, `${U.teacher}/x-${Math.random()}.pdf`, name, person, Y_ACTIVE, U.teacher]);

console.log('\n== Compatible mode (before strict activation): old UI inputs keep working ==');
ok('no strict key yet', !(await one(`SELECT 1 x FROM public.platform_migration_history WHERE migration_key = 'phase_evidence_attribution_strict_v1'`)));
await as('teacher', async () => {
  let r = await insertFile(null);
  ok('compat: file without teacher name saved (old UI)', !r.error, JSON.stringify(r));
  r = await insertLink(null, null, 'https://drive.google.com/file/d/compat1/view');
  ok('compat: Drive link without name and without label saved (old UI)', !r.error && r.rows[0].file_name === null, JSON.stringify(r));
  r = await insertLink('  أ.   هند  ', '  ملف   قديم ', 'http://drive.google.com/file/d/compat2/view');
  ok('compat: http link accepted, spaces normalised in name and label', !r.error && r.rows[0].person === 'أ. هند' && r.rows[0].file_name === 'ملف قديم', JSON.stringify(r));
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'ftp://x.com/a', 'https://drive.google.com/a b']) {
    r = await insertLink('أ. هند', 'ملف', bad);
    ok(`compat: unsafe link still refused: ${bad.slice(0, 20)}`, !!r.error && r.error.includes('https://'), JSON.stringify(r));
  }
});
ok('validation function is SECURITY DEFINER with empty search_path',
  (await one(`SELECT prosecdef AND array_to_string(proconfig, ',') = 'search_path=""' v FROM pg_proc WHERE oid = 'public.validate_evidence_attribution()'::regprocedure`)).v);

console.log('\n== Strict activation (apply twice) ==');
const strictBefore = await evidenceSnap();
try { await applyStrict(db); ok('strict activation applied', true); } catch (e) { ok('strict activation applied', false, e.message); }
try { await applyStrict(db); ok('strict activation re-run is idempotent', true); } catch (e) { ok('strict activation re-run is idempotent', false, e.message); }
ok('strict key recorded exactly once', (await one(`SELECT count(*)::int c FROM public.platform_migration_history WHERE migration_key = 'phase_evidence_attribution_strict_v1'`)).c === 1);
ok('strict activation changes no evidence row', strictBefore === await evidenceSnap());

console.log('\n== Teacher name required on new rows (server side, strict) ==');
await as('teacher', async () => {
  for (const [label, person] of [['NULL', null], ['empty', ''], ['spaces', '   '], ['1 char', 'أ'], ['101 chars', 'س'.repeat(101)]]) {
    const r = await insertFile(person);
    ok(`teacher insert refused: person ${label}`, !!r.error && /اسم المعلمة المسؤولة/.test(r.error), JSON.stringify(r));
  }
  const r = await insertFile('  أ.   سارة   العتيبي ');
  ok('teacher insert with name saved, spaces normalised', !r.error && r.rows[0]?.person === 'أ. سارة العتيبي', JSON.stringify(r));
  const r100 = await insertFile('ن'.repeat(100));
  ok('100-char name accepted', !r100.error, JSON.stringify(r100));
});

console.log('\n== Drive link: display name required, URL kept as-is, https only ==');
await as('teacher', async () => {
  let r = await insertLink('أ. سارة', null);
  ok('link without display name refused', !!r.error && r.error.includes('اسم الملف أو الشاهد'), JSON.stringify(r));
  r = await insertLink('أ. سارة', '   ');
  ok('link with blank display name refused', !!r.error && r.error.includes('اسم الملف أو الشاهد'), JSON.stringify(r));
  r = await insertLink('أ. سارة', 'ط'.repeat(151));
  ok('display name over 150 chars refused', !!r.error && r.error.includes('150'), JSON.stringify(r));
  const url = 'https://drive.google.com/file/d/1AbC-xyz_09/view?usp=drive_link';
  r = await insertLink('أ. سارة', '  تقرير   تنفيذ البرنامج ', url);
  ok('link saved with display name', !r.error && r.rows[0]?.file_name === 'تقرير تنفيذ البرنامج', JSON.stringify(r));
  ok('original link stored exactly', r.rows?.[0]?.link === url, JSON.stringify(r));
  for (const bad of ['http://drive.google.com/file/d/x', 'javascript:alert(1)', 'data:text/html,<b>x</b>', 'https://drive.google.com/a b', 'ftp://x.com/a']) {
    const b = await insertLink('أ. سارة', 'ملف', bad);
    ok(`unsafe link refused: ${bad.slice(0, 24)}`, !!b.error && b.error.includes('https://'), JSON.stringify(b));
  }
  const f = await insertFile('أ. سارة', 'تقرير.pdf');
  ok('uploaded file keeps its own file_name rule (no link label needed)', !f.error && f.rows[0].file_name === 'تقرير.pdf', JSON.stringify(f));
});

console.log('\n== Legacy rows keep working (no forced edit) ==');
await as('admin', async () => {
  let r = await tryQ(`UPDATE public.evidences SET is_approved = true WHERE id = 100 RETURNING id, is_approved, person, file_name`);
  ok('leader approves legacy link with no teacher name and no display name', !r.error && r.rows[0]?.is_approved === true && r.rows[0].person === null && r.rows[0].file_name === null, JSON.stringify(r));
  r = await tryQ(`UPDATE public.evidences SET is_approved = false WHERE id = 100 RETURNING is_approved`);
  ok('leader un-approves legacy link', !r.error && r.rows[0]?.is_approved === false, JSON.stringify(r));
  r = await tryQ(`UPDATE public.evidences SET notes = notes WHERE id = 102 RETURNING id`);
  ok('no-op update on legacy row allowed', !r.error && r.rows.length === 1, JSON.stringify(r));
});
{
  const now = JSON.parse(await evidenceSnap());
  const before = JSON.parse(legacyBefore);
  const pick = rows => rows.map(e => [e.id, e.link, e.file_url, e.file_name, e.person, e.title, e.notes].join('|'));
  ok('legacy link/file/name/teacher/notes unchanged after approve cycle', JSON.stringify(pick(now)) === JSON.stringify(pick(before)));
}

console.log('\n== Permissions unchanged ==');
await as('teacher', async () => {
  let r = await tryQ(`UPDATE public.evidences SET person = 'أخرى' WHERE id = 102 RETURNING id`);
  ok('teacher cannot edit teacher name on any row (0 rows)', !r.error && r.rows.length === 0, JSON.stringify(r));
  r = await tryQ(`UPDATE public.evidences SET is_approved = true WHERE id = 100 RETURNING id`);
  ok('teacher cannot approve (0 rows)', !r.error && r.rows.length === 0, JSON.stringify(r));
  r = await tryQ(`INSERT INTO public.evidences (title, program_id, indicator_id, file_url, file_name, person, school_year_id, created_by, is_approved)
    VALUES ('x', 1, 10, 'u/x.pdf', 'x.pdf', 'أ. سارة', '${Y_ACTIVE}', '${U.teacher}', true)`);
  ok('teacher cannot insert pre-approved', !!r.error && r.error.includes('فقط القائدة'), JSON.stringify(r));
  r = await tryQ(`DELETE FROM public.evidences WHERE id = 100 RETURNING id`);
  ok('teacher cannot delete (0 rows)', !r.error && r.rows.length === 0, JSON.stringify(r));
});
await as('vice', async () => {
  let r = await tryQ(`UPDATE public.evidences SET person = 'أ. هند' WHERE id = 101`);
  ok('approved row: teacher name locked (existing approval lock)', !!r.error && r.error.includes('لا يمكن تعديل مرفق معتمد'), JSON.stringify(r));
  r = await tryQ(`UPDATE public.evidences SET person = '  ' WHERE id = 102`);
  ok('vice cannot blank a teacher name', !!r.error && r.error.includes('اسم المعلمة المسؤولة'), JSON.stringify(r));
  r = await tryQ(`UPDATE public.evidences SET is_approved = true WHERE id = 102`);
  ok('vice cannot approve', !!r.error && r.error.includes('فقط القائدة'), JSON.stringify(r));
});

console.log('\n== Grants hardening migration ==');
const priv = async (role, table, p) => (await one(`SELECT has_table_privilege($1, $2, $3) v`, [role, `public.${table}`, p])).v;
const fpriv = async (role, f) => (await one(`SELECT has_function_privilege($1, $2, 'EXECUTE') v`, [role, f])).v;
ok('before: anon has DELETE on evidence_requirements', await priv('anon', 'evidence_requirements', 'DELETE'));
ok('before: authenticated has TRUNCATE on evidences', await priv('authenticated', 'evidences', 'TRUNCATE'));
const aclMid = await aclSnapshot(db);
try { await applyGrants(db); ok('grants migration applied', true); } catch (e) { ok('grants migration applied', false, e.message); }
try { await applyGrants(db); ok('grants migration re-run is idempotent', true); } catch (e) { ok('grants migration re-run is idempotent', false, e.message); }
for (const t of ['evidences', 'evidence_requirements', 'programs', 'program_indicators', 'initiatives', 'school_years', 'settings', 'teacher_followups', 'tasks']) {
  ok(`${t}: no TRUNCATE/TRIGGER/REFERENCES/MAINTAIN for authenticated`, !(await priv('authenticated', t, 'TRUNCATE'))
    && !(await priv('authenticated', t, 'TRIGGER')) && !(await priv('authenticated', t, 'REFERENCES'))
    && !(await priv('authenticated', t, 'MAINTAIN')));
}
ok('anon has no access to evidence_requirements', !(await priv('anon', 'evidence_requirements', 'SELECT')) && !(await priv('anon', 'evidence_requirements', 'DELETE')));
ok('authenticated keeps SELECT/INSERT/UPDATE/DELETE', await priv('authenticated', 'evidences', 'SELECT') && await priv('authenticated', 'evidences', 'INSERT')
  && await priv('authenticated', 'evidences', 'UPDATE') && await priv('authenticated', 'evidences', 'DELETE')
  && await priv('authenticated', 'evidence_requirements', 'INSERT') && await priv('authenticated', 'programs', 'UPDATE'));
ok('service_role keeps TRUNCATE', await priv('service_role', 'evidences', 'TRUNCATE'));
ok('anon cannot execute is_admin/current_app_role/list_school_years', !(await fpriv('anon', 'public.is_admin()'))
  && !(await fpriv('anon', 'public.current_app_role()')) && !(await fpriv('anon', 'public.list_school_years(boolean)')));
ok('authenticated still executes RLS helpers', await fpriv('authenticated', 'public.is_admin()') && await fpriv('authenticated', 'public.current_app_role()')
  && await fpriv('authenticated', 'public.school_year_allows_write(uuid)') && await fpriv('authenticated', 'public.get_active_school_year()'));
ok('trigger functions not executable by authenticated', !(await fpriv('authenticated', 'public.set_evidence_created_by()'))
  && !(await fpriv('authenticated', 'public.protect_approved_evidence_attachment()')));

await as('teacher', async () => {
  let r = await tryQ(`TRUNCATE public.evidences`);
  ok('teacher TRUNCATE evidences denied', !!r.error && /permission denied/.test(r.error), JSON.stringify(r));
  r = await tryQ(`TRUNCATE public.evidence_requirements`);
  ok('teacher TRUNCATE evidence_requirements denied', !!r.error && /permission denied/.test(r.error), JSON.stringify(r));
  r = await tryQ(`SELECT public.set_evidence_created_by()`);
  ok('teacher cannot call trigger function via RPC', !!r.error && /permission denied/.test(r.error), JSON.stringify(r));
  r = await tryQ(`INSERT INTO public.evidences (title, program_id, indicator_id, requirement_id, link, file_name, person, school_year_id)
    VALUES ('تقرير التنفيذ', 1, 10, $1, 'https://drive.google.com/file/d/after/view', 'ملف بعد التشديد', 'أ. سارة', $2) RETURNING created_by`, [R1, Y_ACTIVE]);
  ok('triggers still fire after revoke (created_by set by trigger, insert allowed by RLS)', !r.error && r.rows[0]?.created_by === U.teacher, JSON.stringify(r));
  r = await tryQ(`SELECT count(*)::int c FROM public.evidences`);
  ok('teacher still reads evidences', !r.error && r.rows[0].c > 3, JSON.stringify(r));
});
await as('admin', async () => {
  const r = await tryQ(`UPDATE public.evidences SET is_approved = true WHERE id = 100 RETURNING is_approved`);
  ok('leader approval still works after hardening', !r.error && r.rows[0]?.is_approved === true, JSON.stringify(r));
});
await as('anon', async () => {
  let r = await tryQ(`SELECT * FROM public.evidence_requirements`);
  ok('anon SELECT evidence_requirements denied', !!r.error && /permission denied/.test(r.error), JSON.stringify(r));
  r = await tryQ(`SELECT public.is_admin()`);
  ok('anon RPC is_admin denied', !!r.error && /permission denied/.test(r.error), JSON.stringify(r));
  r = await tryQ(`SELECT * FROM public.list_school_years(true)`);
  ok('anon RPC list_school_years denied', !!r.error && /permission denied/.test(r.error), JSON.stringify(r));
});
ok('evidence_attachment_present has fixed search_path',
  (await one(`SELECT array_to_string(proconfig, ',') c FROM pg_proc WHERE oid = 'public.evidence_attachment_present(jsonb)'::regprocedure`)).c === 'search_path=""');

console.log('\n== Rollback blocks ==');
try { await db.exec(rollbackBlock(GRANTS)); ok('grants rollback runs', true); } catch (e) { ok('grants rollback runs', false, e.message); }
ok('grants rollback restores ACLs exactly', aclMid === await aclSnapshot(db));
try { await db.exec(rollbackBlock(ATTRIBUTION)); ok('attribution rollback runs', true); } catch (e) { ok('attribution rollback runs', false, e.message); }
ok('attribution rollback: trigger removed', !(await one(`SELECT 1 x FROM pg_trigger WHERE tgname = 'trg_validate_evidence_attribution'`)));
ok('after both rollbacks ACLs equal the original', aclBefore === await aclSnapshot(db));
await as('teacher', async () => {
  const r = await insertFile(null);
  ok('after rollback the old behaviour returns (insert without name)', !r.error, JSON.stringify(r));
});
ok('migration history cleaned by rollbacks (incl. strict key)', !(await one(`SELECT 1 x FROM public.platform_migration_history
  WHERE migration_key IN ('phase_evidence_attribution_v1', 'phase_evidence_attribution_strict_v1', 'phase_security_grants_hardening_v1')`)));

console.log('\n== Standalone rollback files ==');
for (const name of [ATTRIBUTION, STRICT, GRANTS]) {
  ok(`${ROLLBACK_FILES[name]} contains the embedded block byte-for-byte`,
    rollbackFile(name).replace(/\r\n/g, '\n').includes(rollbackBlock(name)));
}
ok('security rollback file carries the emergency-only warning',
  /RE-OPENS dangerous anon privileges/.test(rollbackFile(GRANTS)) && /DELETE and TRUNCATE/.test(rollbackFile(GRANTS))
  && /Never run automatically/.test(rollbackFile(GRANTS)) && /FIRST fix the specific missing GRANT/.test(rollbackFile(GRANTS)));
{
  const code = s => s.replace(/^\s*--.*$/gm, '');
  ok('no GRANT ALL statement in either migration or rollback',
    ![ATTRIBUTION, STRICT, GRANTS].some(n => /GRANT\s+ALL/i.test(code(sqlFile(n))) || /GRANT\s+ALL/i.test(code(rollbackFile(n)))));
}

const comment = async (d, col) => (await d.query(`SELECT col_description('public.evidences'::regclass, attnum) c
  FROM pg_attribute WHERE attrelid = 'public.evidences'::regclass AND attname = $1`, [col])).rows[0].c;
const historyCount = async (d, key) => (await d.query(`SELECT count(*)::int c FROM public.platform_migration_history WHERE migration_key = $1`, [key])).rows[0].c;
const schemaSnap = async d => JSON.stringify({
  trg: (await d.query(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.evidences'::regclass AND NOT tgisinternal ORDER BY 1`)).rows,
  fn: (await d.query(`SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace ORDER BY 1`)).rows,
  person: await comment(d, 'person'), file_name: await comment(d, 'file_name'),
  cols: (await d.query(`SELECT attname, attnotnull, format_type(atttypid, atttypmod) t FROM pg_attribute
    WHERE attrelid = 'public.evidences'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum`)).rows,
});

console.log('\n== Attribution migration alone: run twice, then its standalone rollback ==');
{
  const d = new PGlite();
  await buildAll(d, { attribution: false, grants: false });
  const h = makeHelpers(d);
  await d.exec(`INSERT INTO public.programs (id, name, school_year_id) VALUES (1, 'برنامج', '${Y_ACTIVE}');
    INSERT INTO public.program_indicators (id, program_id, indicator_text) VALUES (10, 1, 'مؤشر');
    INSERT INTO public.evidences (id, title, program_id, indicator_id, link, school_year_id, created_by)
      VALUES (1, 'قديم', 1, 10, 'https://drive.google.com/file/d/OLD/view', '${Y_ACTIVE}', '${U.teacher}');`);
  const s0 = await schemaSnap(d), a0 = await aclSnapshot(d);
  const rows0 = JSON.stringify((await d.query(`SELECT * FROM public.evidences ORDER BY id`)).rows);
  await applyAttribution(d);
  ok('first run records the key once', await historyCount(d, 'phase_evidence_attribution_v1') === 1);
  await applyAttribution(d);
  ok('second run: still exactly one key (ROW_COUNT 0 accepted)', await historyCount(d, 'phase_evidence_attribution_v1') === 1);
  ok('file_name comment untouched by the migration', await comment(d, 'file_name') === 'اسم الملف الأصلي كما رفعه المستخدم.');
  ok('no column became NOT NULL', !JSON.parse(await schemaSnap(d)).cols.some(c => ['person', 'file_name', 'link'].includes(c.attname) && c.attnotnull));
  ok('legacy row unchanged after two runs', rows0 === JSON.stringify((await d.query(`SELECT * FROM public.evidences ORDER BY id`)).rows));
  await applyStrict(d);
  await applyStrict(d);
  ok('strict activation x2: strict key once', await historyCount(d, 'phase_evidence_attribution_strict_v1') === 1);
  let r = await h.as('teacher', () => h.tryQ(`INSERT INTO public.evidences (id, title, program_id, indicator_id, link, school_year_id)
    VALUES (3, 'بلا اسم', 1, 10, 'https://drive.google.com/file/d/X/view', '${Y_ACTIVE}')`));
  ok('strict: insert without teacher name refused', !!r.error && r.error.includes('اسم المعلمة المسؤولة'), JSON.stringify(r));
  try { await d.exec(rollbackFile(STRICT)); ok('strict standalone rollback runs', true); } catch (e) { ok('strict standalone rollback runs', false, e.message); }
  ok('strict rollback removes only the strict key', await historyCount(d, 'phase_evidence_attribution_strict_v1') === 0
    && await historyCount(d, 'phase_evidence_attribution_v1') === 1);
  r = await h.as('teacher', () => h.tryQ(`INSERT INTO public.evidences (id, title, program_id, indicator_id, link, school_year_id)
    VALUES (4, 'بلا اسم', 1, 10, 'https://drive.google.com/file/d/Y/view', '${Y_ACTIVE}') RETURNING id`));
  ok('after strict rollback: compatible mode again (insert without name accepted)', !r.error, JSON.stringify(r));
  try { await d.exec(rollbackFile(STRICT)); ok('strict rollback is re-runnable', true); } catch (e) { ok('strict rollback is re-runnable', false, e.message); }
  await applyStrict(d);
  await h.as('teacher', () => h.tryQ(`INSERT INTO public.evidences (id, title, program_id, indicator_id, link, file_name, person, school_year_id)
    VALUES (2, 'جديد', 1, 10, 'https://drive.google.com/file/d/NEW/view', 'ملف جديد', 'معلمة تجريبية', '${Y_ACTIVE}')`));
  try { await d.exec(rollbackFile(ATTRIBUTION)); ok('attribution standalone rollback runs', true); } catch (e) { ok('attribution standalone rollback runs', false, e.message); }
  ok('full rollback also removes the strict key', await historyCount(d, 'phase_evidence_attribution_strict_v1') === 0);
  ok('rollback restores triggers/functions/comments/columns exactly', s0 === await schemaSnap(d), await schemaSnap(d));
  ok('rollback leaves ACLs untouched', a0 === await aclSnapshot(d));
  ok('rollback drops no column and keeps data added after the migration',
    JSON.stringify((await d.query(`SELECT person, file_name, link FROM public.evidences WHERE id = 2`)).rows[0])
      === JSON.stringify({ person: 'معلمة تجريبية', file_name: 'ملف جديد', link: 'https://drive.google.com/file/d/NEW/view' }));
  ok('rollback keeps the legacy row unchanged', rows0 === JSON.stringify((await d.query(`SELECT * FROM public.evidences WHERE id = 1`)).rows));
  ok('rows inserted in compatible mode stay as they were', (await d.query(`SELECT person FROM public.evidences WHERE id = 4`)).rows[0]?.person === null);
  ok('rollback removes the history key', await historyCount(d, 'phase_evidence_attribution_v1') === 0);
  try { await d.exec(rollbackFile(ATTRIBUTION)); ok('attribution rollback is re-runnable', true); } catch (e) { ok('attribution rollback is re-runnable', false, e.message); }
}

console.log('\n== Grants migration alone: run twice, real triggers, RLS helpers, then its standalone rollback ==');
{
  const d = new PGlite();
  await buildAll(d, { attribution: false, grants: false });
  const h = makeHelpers(d);
  const RQ = '80000000-0000-0000-0000-000000000001';
  await d.exec(`INSERT INTO public.programs (id, name, school_year_id) VALUES (1, 'برنامج', '${Y_ACTIVE}');
    INSERT INTO public.program_indicators (id, program_id, indicator_text) VALUES (10, 1, 'مؤشر'), (11, 1, 'مؤشر آخر');
    INSERT INTO public.evidence_requirements (id, indicator_id, name) VALUES ('${RQ}', 10, 'شاهد');`);
  const a0 = await aclSnapshot(d);
  await applyGrants(d);
  ok('first run records the key once', await historyCount(d, 'phase_security_grants_hardening_v1') === 1);
  await applyGrants(d);
  ok('second run: still exactly one key', await historyCount(d, 'phase_security_grants_hardening_v1') === 1);
  const priv = async (role, table, p) => (await d.query(`SELECT has_table_privilege($1, $2, $3) v`, [role, `public.${table}`, p])).rows[0].v;
  const fpriv = async (role, f) => (await d.query(`SELECT has_function_privilege($1, $2, 'EXECUTE') v`, [role, f])).rows[0].v;
  const ALL14 = ['evidences', 'evidence_requirements', 'programs', 'program_indicators', 'initiatives', 'school_years', 'settings',
    'teacher_followups', 'tasks', 'kpis', 'profiles', 'reports', 'users', 'platform_migration_history'];
  const P8 = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'];
  let leaks = [];
  for (const t of ALL14) for (const p of P8) for (const r of ['public', 'anon']) if (await priv(r, t, p)) leaks.push(`${r}:${t}:${p}`);
  ok('PUBLIC and anon hold none of the 8 privileges on all 14 tables', leaks.length === 0, leaks.join(','));
  leaks = [];
  for (const t of ALL14) for (const p of ['TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) if (await priv('authenticated', t, p)) leaks.push(`${t}:${p}`);
  ok('authenticated holds no TRUNCATE/REFERENCES/TRIGGER/MAINTAIN on all 14 tables', leaks.length === 0, leaks.join(','));
  const TRIG = ['enforce_evidence_requirement_approval()', 'enforce_evidence_requirement_indicator_match()',
    'prevent_delete_requirement_with_approved_attachment()', 'protect_approved_evidence_attachment()', 'set_evidence_created_by()',
    'set_evidence_requirement_created_by()', 'set_evidence_requirements_updated_at()', 'set_profiles_updated_at()', 'rls_auto_enable()',
    'evidence_attachment_present(jsonb)'].map(f => 'public.' + f);
  leaks = [];
  for (const f of TRIG) for (const r of ['public', 'anon', 'authenticated']) if (await fpriv(r, f)) leaks.push(`${r}:${f}`);
  ok('all 10 trigger/helper functions: no EXECUTE for PUBLIC/anon/authenticated', leaks.length === 0, leaks.join(','));
  ok('owner postgres and service_role still execute all 10', (await Promise.all(TRIG.map(f => fpriv('postgres', f)))).every(Boolean)
    && (await Promise.all(TRIG.map(f => fpriv('service_role', f)))).every(Boolean));

  await h.as('teacher', async () => {
    let r = await h.tryQ(`INSERT INTO public.evidences (title, program_id, indicator_id, requirement_id, link, school_year_id)
      VALUES ('شاهد', 1, 10, $1, 'https://drive.google.com/file/d/A/view', $2) RETURNING id, created_by`, [RQ, Y_ACTIVE]);
    ok('trigger set_evidence_created_by fires for teacher INSERT', !r.error && r.rows[0]?.created_by === U.teacher, JSON.stringify(r));
    r = await h.tryQ(`INSERT INTO public.evidences (title, program_id, indicator_id, requirement_id, link, school_year_id)
      VALUES ('شاهد', 1, 11, $1, 'https://drive.google.com/file/d/B/view', $2)`, [RQ, Y_ACTIVE]);
    ok('trigger enforce_evidence_requirement_indicator_match rejects a mismatched indicator', !!r.error && /indicator_id/.test(r.error), JSON.stringify(r));
    r = await h.tryQ(`INSERT INTO public.evidences (title, program_id, indicator_id, school_year_id) VALUES ('بلا مرفق', 1, 10, $1) RETURNING id`, [Y_ACTIVE]);
    ok('teacher inserts a row without attachment (for the next check)', !r.error, JSON.stringify(r));
  });
  await h.as('admin', async () => {
    const withAtt = (await d.query(`SELECT id FROM public.evidences WHERE link LIKE '%/A/%'`)).rows[0].id;
    const noAtt = (await d.query(`SELECT id FROM public.evidences WHERE title = 'بلا مرفق'`)).rows[0].id;
    let r = await h.tryQ(`UPDATE public.evidences SET is_approved = true WHERE id = $1 RETURNING is_approved, approved_by`, [withAtt]);
    ok('trigger protect_approved_evidence_attachment + evidence_attachment_present (search_path="") approve with attachment',
      !r.error && r.rows[0]?.is_approved === true && r.rows[0].approved_by === U.admin, JSON.stringify(r));
    r = await h.tryQ(`UPDATE public.evidences SET is_approved = true WHERE id = $1`, [noAtt]);
    ok('evidence_attachment_present returns false inside the trigger (approval without attachment refused)',
      !!r.error && r.error.includes('بدون ملف أو رابط'), JSON.stringify(r));
    r = await h.tryQ(`DELETE FROM public.evidence_requirements WHERE id = $1`, [RQ]);
    ok('trigger prevent_delete_requirement_with_approved_attachment fires', !!r.error && r.error.includes('ألغِ اعتماد'), JSON.stringify(r));
    r = await h.tryQ(`INSERT INTO public.evidence_requirements (indicator_id, name) VALUES (11, 'جديد') RETURNING id, created_by, updated_at`);
    ok('trigger set_evidence_requirement_created_by fires', !r.error && r.rows[0]?.created_by === U.admin, JSON.stringify(r));
    const before = r.rows[0].updated_at;
    await d.query(`SELECT pg_sleep(0.01)`);
    r = await h.tryQ(`UPDATE public.evidence_requirements SET name = 'جديد ٢' WHERE id = $1 RETURNING updated_at`, [r.rows[0].id]);
    ok('trigger set_evidence_requirements_updated_at fires on leader UPDATE',
      !r.error && r.rows.length === 1 && new Date(r.rows[0].updated_at).getTime() > new Date(before).getTime(), JSON.stringify(r));
    r = await h.tryQ(`UPDATE public.evidences SET is_approved = false WHERE id = $1 RETURNING is_approved`, [withAtt]);
    ok('leader un-approves', !r.error && r.rows[0]?.is_approved === false, JSON.stringify(r));
  });
  await h.as('vice', async () => {
    const r = await h.tryQ(`INSERT INTO public.evidence_requirements (indicator_id, name, is_approved) VALUES (11, 'x', true)`);
    ok('trigger enforce_evidence_requirement_approval blocks non-leader approval', !!r.error && r.error.includes('فقط القائدة'), JSON.stringify(r));
  });
  for (const role of ['admin', 'teacher']) {
    await h.as(role, async () => {
      const r = await h.tryQ(`SELECT public.is_admin() a, public.is_staff() s, public.current_app_role() c,
        public.school_year_allows_read('${Y_ACTIVE}') rd, public.school_year_allows_write('${Y_ACTIVE}') wr,
        public.school_year_is_active('${Y_ACTIVE}') ac,
        (SELECT count(*)::int FROM public.get_active_school_year()) g, (SELECT count(*)::int FROM public.list_school_years(true)) l`);
      const x = r.rows?.[0];
      ok(`${role}: the 8 RLS/UI helper functions run as authenticated`, !r.error && x.c === role && x.a === (role === 'admin')
        && x.s === (role === 'admin') && x.rd && x.wr && x.ac && x.g === 1 && x.l >= 1, JSON.stringify(r));
    });
  }
  try { await d.exec(rollbackFile(GRANTS)); ok('grants standalone rollback runs', true); } catch (e) { ok('grants standalone rollback runs', false, e.message); }
  ok('grants standalone rollback restores ACLs + function config exactly', a0 === await aclSnapshot(d));
  ok('grants rollback removes the history key', await historyCount(d, 'phase_security_grants_hardening_v1') === 0);
}

console.log('\n== Grandfathering: legacy rows keep working in strict mode; content edits and new rows are strict ==');
// Test fixture only (not production numbers): 4 legacy rows inserted with the trigger disabled, like pre-attribution data —
// ids 1 (Drive link), 2 (Storage file + note), 3 (http link), 5 (link used for the valid-edit case); none has person/file_name.
// The migrations themselves never assume counts: their pre/postchecks compare live counts + fingerprints at apply time.
{
  const d = new PGlite();
  // production today: attribution (compatible) + security hardening, no grandfathering, no strict
  await buildAll(d, { attribution: true, grandfather: false, strict: false, grants: true });
  const h = makeHelpers(d);
  const RQ = '90000000-0000-0000-0000-000000000009';
  await d.exec(`INSERT INTO public.programs (id, name, school_year_id) VALUES (1, 'برنامج', '${Y_ACTIVE}');
    INSERT INTO public.program_indicators (id, program_id, indicator_text) VALUES (10, 1, 'مؤشر');
    INSERT INTO public.evidence_requirements (id, indicator_id, name) VALUES ('${RQ}', 10, 'شاهد');
    ALTER TABLE public.evidences DISABLE TRIGGER trg_validate_evidence_attribution;
    INSERT INTO public.evidences (id, title, program_id, indicator_id, requirement_id, link, school_year_id, created_by, type) VALUES
      (1, 'قديم رابط', 1, 10, '${RQ}', 'https://drive.google.com/file/d/L1/view', '${Y_ACTIVE}', '${U.teacher}', 'Google Drive'),
      (3, 'قديم http', 1, 10, '${RQ}', 'http://drive.google.com/file/d/L3/view', '${Y_ACTIVE}', '${U.teacher}', 'Google Drive'),
      (5, 'قديم للتعديل', 1, 10, '${RQ}', 'https://drive.google.com/file/d/L5/view', '${Y_ACTIVE}', '${U.teacher}', 'Google Drive');
    INSERT INTO public.evidences (id, title, program_id, indicator_id, requirement_id, file_url, file_name, school_year_id, created_by, type, notes) VALUES
      (2, 'قديم ملف', 1, 10, '${RQ}', '${U.teacher}/legacy2.pdf', 'legacy2.pdf', '${Y_ACTIVE}', '${U.teacher}', 'PDF', 'ملاحظة');
    ALTER TABLE public.evidences ENABLE TRIGGER trg_validate_evidence_attribution;
    SELECT setval(pg_get_serial_sequence('public.evidences', 'id'), 100);`);
  const fp = async () => (await d.query(`SELECT count(*)::int c, md5(string_agg(to_jsonb(e)::text, ',' ORDER BY e.id)) m
    FROM public.evidences e WHERE e.id < 100`)).rows[0];
  const content = async () => JSON.stringify((await d.query(`SELECT id, title, person, file_name, file_url, link, evidence_link, type
    FROM public.evidences WHERE id < 100 ORDER BY id`)).rows);
  const fnMd5 = async () => (await d.query(`SELECT md5(prosrc) m FROM pg_proc WHERE oid = 'public.validate_evidence_attribution()'::regprocedure`)).rows[0].m;
  const legacy0 = await fp();
  const content0 = await content();
  ok('setup: 4 legacy rows, none has a teacher name or link label', legacy0.c === 4
    && (await d.query(`SELECT count(*)::int c FROM public.evidences WHERE person IS NULL`)).rows[0].c === 4);
  ok('before: deployed function body is f1aeb900…', await fnMd5() === 'f1aeb900e059ceba0a178856fb355743');

  try { await applyGrandfather(d); ok('grandfathering migration applied', true); } catch (e) { ok('grandfathering migration applied', false, e.message); }
  try { await applyGrandfather(d); ok('grandfathering migration re-run is idempotent', true); } catch (e) { ok('grandfathering migration re-run is idempotent', false, e.message); }
  ok('history key recorded exactly once', await historyCount(d, 'phase_evidence_attribution_grandfathering_v1') === 1);
  ok('function body is the reviewed version (d6152820…)', await fnMd5() === 'd61528202d04396bb9e47118a3a673ab');
  ok('function stays SECURITY DEFINER, empty search_path, not callable by PUBLIC/anon/authenticated',
    (await d.query(`SELECT prosecdef AND array_to_string(proconfig, ',') = 'search_path=""'
      AND NOT has_function_privilege('public', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
      AND NOT has_function_privilege('authenticated', oid, 'EXECUTE') v FROM pg_proc WHERE oid = 'public.validate_evidence_attribution()'::regprocedure`)).rows[0].v);
  ok('legacy rows: count + fingerprint unchanged by the migration', JSON.stringify(await fp()) === JSON.stringify(legacy0));

  await h.as('teacher', async () => {
    const r = await h.tryQ(`INSERT INTO public.evidences (title, program_id, indicator_id, link, school_year_id) VALUES ('compat', 1, 10, 'http://drive.google.com/x/y', $1) RETURNING id`, [Y_ACTIVE]);
    ok('compatible mode unchanged: insert without name / label with http link still accepted', !r.error, JSON.stringify(r));
  });

  await applyStrict(d);
  ok('strict activated; legacy rows still unchanged (no backfill, no default names)', JSON.stringify(await fp()) === JSON.stringify(legacy0)
    && (await d.query(`SELECT count(*)::int c FROM public.evidences WHERE id < 100 AND person IS NULL AND file_name IS NULL AND link IS NOT NULL`)).rows[0].c === 3);

  await h.as('admin', async () => {
    let r = await h.tryQ(`UPDATE public.evidences SET is_approved = true WHERE id = 1 RETURNING is_approved, approved_by, approved_at, person`);
    ok('strict: leader approves a legacy link without teacher name', !r.error && r.rows[0]?.is_approved === true && r.rows[0].approved_by === U.admin && !!r.rows[0].approved_at && r.rows[0].person === null, JSON.stringify(r));
    r = await h.tryQ(`UPDATE public.evidences SET is_approved = false WHERE id = 1 RETURNING is_approved, approved_by`);
    ok('strict: leader un-approves it', !r.error && r.rows[0]?.is_approved === false && r.rows[0].approved_by === null, JSON.stringify(r));
    r = await h.tryQ(`UPDATE public.evidences SET is_approved = true WHERE id = 3 RETURNING is_approved`);
    ok('strict: leader approves a legacy http link without name (link untouched)', !r.error && r.rows[0]?.is_approved === true, JSON.stringify(r));
    r = await h.tryQ(`UPDATE public.evidences SET is_approved = false WHERE id = 3 RETURNING is_approved`);
    ok('strict: leader un-approves the legacy http link', !r.error && r.rows[0]?.is_approved === false, JSON.stringify(r));
    r = await h.tryQ(`UPDATE public.evidences SET is_approved = true WHERE id = 2 RETURNING is_approved`);
    ok('strict: leader approves a legacy file without name', !r.error && r.rows[0]?.is_approved === true, JSON.stringify(r));
    r = await h.tryQ(`UPDATE public.evidences SET is_approved = false WHERE id = 2 RETURNING is_approved`);
    ok('strict: leader un-approves the legacy file', !r.error && r.rows[0]?.is_approved === false, JSON.stringify(r));
  });
  await h.as('vice', async () => {
    const r = await h.tryQ(`UPDATE public.evidences SET notes = 'ملاحظة محدّثة' WHERE id = 2 RETURNING notes, person`);
    ok('strict: notes on a legacy row without name can be updated', !r.error && r.rows[0]?.notes === 'ملاحظة محدّثة' && r.rows[0].person === null, JSON.stringify(r));
  });
  ok('legacy content (title/person/file/link/label/type) untouched by approvals and notes', await content() === content0);

  await h.as('teacher', async () => {
    let r = await h.tryQ(`INSERT INTO public.evidences (title, program_id, indicator_id, requirement_id, link, file_name, school_year_id)
      VALUES ('جديد', 1, 10, $1, 'https://drive.google.com/file/d/N1/view', 'ملف', $2)`, [RQ, Y_ACTIVE]);
    ok('strict: NEW evidence without teacher name refused', !!r.error && r.error.includes('يرجى كتابة اسم المعلمة المسؤولة'), JSON.stringify(r));
    r = await h.tryQ(`INSERT INTO public.evidences (title, program_id, indicator_id, requirement_id, link, file_name, person, school_year_id)
      VALUES ('جديد', 1, 10, $1, 'https://drive.google.com/file/d/N2/view', 'ملف', 'أ', $2)`, [RQ, Y_ACTIVE]);
    ok('strict: NEW evidence with a 1-char name refused', !!r.error && r.error.includes('بين 2 و100'), JSON.stringify(r));
    r = await h.tryQ(`INSERT INTO public.evidences (title, program_id, indicator_id, requirement_id, link, person, school_year_id)
      VALUES ('جديد', 1, 10, $1, 'https://drive.google.com/file/d/N3/view', 'معلمة تجريبية', $2)`, [RQ, Y_ACTIVE]);
    ok('strict: NEW link without display name refused', !!r.error && r.error.includes('اسم الملف أو الشاهد'), JSON.stringify(r));
    r = await h.tryQ(`INSERT INTO public.evidences (title, program_id, indicator_id, requirement_id, link, file_name, person, school_year_id)
      VALUES ('جديد', 1, 10, $1, 'http://drive.google.com/file/d/N4/view', 'ملف', 'معلمة تجريبية', $2)`, [RQ, Y_ACTIVE]);
    ok('strict: NEW http link refused (https only)', !!r.error && r.error.includes('https://'), JSON.stringify(r));
    r = await h.tryQ(`INSERT INTO public.evidences (title, program_id, indicator_id, requirement_id, link, file_name, person, school_year_id)
      VALUES ('جديد', 1, 10, $1, 'https://drive.google.com/file/d/N5/view', '  تقرير   جديد ', '  معلمة   تجريبية ', $2) RETURNING person, file_name`, [RQ, Y_ACTIVE]);
    ok('strict: NEW valid link saved (name and label normalised)', !r.error && r.rows[0].person === 'معلمة تجريبية' && r.rows[0].file_name === 'تقرير جديد', JSON.stringify(r));
    r = await h.tryQ(`INSERT INTO public.evidences (title, program_id, indicator_id, requirement_id, file_url, file_name, person, school_year_id)
      VALUES ('جديد', 1, 10, $1, $2, 'ملف.pdf', 'معلمة تجريبية', $3) RETURNING id`, [RQ, `${U.teacher}/new.pdf`, Y_ACTIVE]);
    ok('strict: NEW valid file saved', !r.error, JSON.stringify(r));
  });

  await h.as('vice', async () => {
    let r = await h.tryQ(`UPDATE public.evidences SET link = 'https://drive.google.com/file/d/L5b/view' WHERE id = 5`);
    ok('strict: changing the LINK of a legacy row without teacher name is refused (rule 5)', !!r.error && r.error.includes('يرجى كتابة اسم المعلمة المسؤولة'), JSON.stringify(r));
    r = await h.tryQ(`UPDATE public.evidences SET file_url = '${U.teacher}/legacy2-new.pdf' WHERE id = 2`);
    ok('strict: changing the FILE of a legacy row without teacher name is refused (rule 5)', !!r.error && r.error.includes('يرجى كتابة اسم المعلمة المسؤولة'), JSON.stringify(r));
    r = await h.tryQ(`UPDATE public.evidences SET file_name = 'اسم عرض' WHERE id = 5`);
    ok('strict: changing the DISPLAY NAME of a legacy row without teacher name is refused (rule 5)', !!r.error && r.error.includes('يرجى كتابة اسم المعلمة المسؤولة'), JSON.stringify(r));
    r = await h.tryQ(`UPDATE public.evidences SET person = 'معلمة تجريبية' WHERE id = 5`);
    ok('strict: adding a teacher name to a legacy link without label → label required too (rule 5)', !!r.error && r.error.includes('اسم الملف أو الشاهد'), JSON.stringify(r));
    r = await h.tryQ(`UPDATE public.evidences SET person = 'معلمة تجريبية' WHERE id = 3`);
    ok('strict: editing a legacy http link’s teacher name → https required (rule 5)', !!r.error && r.error.includes('https://'), JSON.stringify(r));
    r = await h.tryQ(`UPDATE public.evidences SET person = ' معلمة  تجريبية ', file_name = 'رابط مُسمّى', link = 'https://drive.google.com/file/d/L5c/view'
      WHERE id = 5 RETURNING person, file_name, link`);
    ok('strict: legacy row updated with valid name + label + https is accepted (and normalised)',
      !r.error && r.rows[0]?.person === 'معلمة تجريبية' && r.rows[0].file_name === 'رابط مُسمّى', JSON.stringify(r));
  });
  ok('the refused updates left legacy rows 1–3 untouched', JSON.stringify(JSON.parse(await content()).filter(x => x.id !== 5))
    === JSON.stringify(JSON.parse(content0).filter(x => x.id !== 5)));

  ok('function owner is postgres; EXECUTE only for postgres/service_role; no dynamic SQL; tables qualified with public.',
    (await d.query(`SELECT pg_get_userbyid(p.proowner) = 'postgres'
        AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE'
                        AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) NOT IN ('postgres', 'service_role')))
        AND p.prosrc !~* '(^|[^a-z_])(execute|format)([^a-z_]|$)'
        AND regexp_replace(p.prosrc, 'distinct\\s+from', '', 'gi') !~* '(^|[^a-z_])(from|join|update|insert\\s+into|delete\\s+from)\\s+(?!public\\.)'
        AND p.prosrc ~ 'FROM public\\.platform_migration_history' v
      FROM pg_proc p WHERE p.oid = 'public.validate_evidence_attribution()'::regprocedure`)).rows[0].v);

  console.log('-- rollback scope guard: refuses while strict is enabled --');
  const histKeys = async () => JSON.stringify((await d.query(`SELECT migration_key FROM public.platform_migration_history ORDER BY 1`)).rows);
  const fullRows = async () => JSON.stringify((await d.query(`SELECT * FROM public.evidences ORDER BY id`)).rows);
  const keys0 = await histKeys(), rows0 = await fullRows(), acl0 = await aclSnapshot(d);
  ok('state: grandfathering applied + strict enabled', await fnMd5() === 'd61528202d04396bb9e47118a3a673ab'
    && await historyCount(d, 'phase_evidence_attribution_strict_v1') === 1 && await historyCount(d, 'phase_evidence_attribution_grandfathering_v1') === 1);
  let refused = null;
  try { await d.exec(rollbackFile(GRANDFATHER)); } catch (e) { refused = e.message; }
  try { await d.exec('ROLLBACK'); } catch {}
  ok('grandfathering rollback with strict ON stops with a clear message', !!refused && refused.includes('الوضع الصارم مفعّل')
    && refused.includes('phase_evidence_attribution_strict_rollback_review.sql'), refused);
  ok('…and changed nothing: function body still d6152820…', await fnMd5() === 'd61528202d04396bb9e47118a3a673ab');
  ok('…history keys unchanged', await histKeys() === keys0);
  ok('…every evidence row unchanged', await fullRows() === rows0);
  ok('…ACLs unchanged', await aclSnapshot(d) === acl0);

  console.log('-- correct order: strict rollback → grandfathering rollback --');
  try { await d.exec(rollbackFile(STRICT)); ok('strict rollback runs', true); } catch (e) { ok('strict rollback runs', false, e.message); }
  ok('compatible mode again (strict key removed)', await historyCount(d, 'phase_evidence_attribution_strict_v1') === 0);
  try { await d.exec(rollbackFile(GRANDFATHER)); ok('grandfathering rollback now succeeds', true); } catch (e) { ok('grandfathering rollback now succeeds', false, e.message); }
  ok('rollback restores the previous body verbatim (f1aeb900…)', await fnMd5() === 'f1aeb900e059ceba0a178856fb355743');
  ok('rollback removes only its own history key (attribution key kept, strict stays off)',
    await historyCount(d, 'phase_evidence_attribution_grandfathering_v1') === 0
    && await historyCount(d, 'phase_evidence_attribution_strict_v1') === 0 && await historyCount(d, 'phase_evidence_attribution_v1') === 1);
  ok('rollback keeps owner postgres / SECURITY DEFINER / empty search_path / no EXECUTE for users / same ACL',
    (await d.query(`SELECT pg_get_userbyid(proowner) = 'postgres' AND prosecdef AND array_to_string(proconfig, ',') = 'search_path=""'
      AND NOT has_function_privilege('public', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
      AND NOT has_function_privilege('authenticated', oid, 'EXECUTE') v FROM pg_proc WHERE oid = 'public.validate_evidence_attribution()'::regprocedure`)).rows[0].v
    && await aclSnapshot(d) === acl0);
  ok('legacy rows unchanged by both rollbacks', await fullRows() === rows0);
  try { await d.exec(rollbackFile(GRANDFATHER)); ok('grandfathering rollback re-run is safe (DELETE ROW_COUNT 0 accepted)', await fnMd5() === 'f1aeb900e059ceba0a178856fb355743'); }
  catch (e) { ok('grandfathering rollback re-run is safe (DELETE ROW_COUNT 0 accepted)', false, e.message); }
  await h.as('teacher', async () => {
    const r = await h.tryQ(`INSERT INTO public.evidences (title, program_id, indicator_id, link, school_year_id) VALUES ('compat2', 1, 10, 'http://drive.google.com/a/b', $1) RETURNING id`, [Y_ACTIVE]);
    ok('compatible mode behaviour after both rollbacks (no name / label required, http accepted)', !r.error, JSON.stringify(r));
  });
  try { await applyGrandfather(d); ok('grandfathering can be re-applied after its rollback', await fnMd5() === 'd61528202d04396bb9e47118a3a673ab'); } catch (e) { ok('grandfathering can be re-applied after its rollback', false, e.message); }
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
}
