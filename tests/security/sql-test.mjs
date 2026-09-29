import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

export const REPO = fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\/]$/, '');
const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
};

export const U = {
  admin:    '00000000-0000-0000-0000-00000000000a',
  vice:     '00000000-0000-0000-0000-00000000000b',
  teacher:  '00000000-0000-0000-0000-00000000000c',
  teacher2: '00000000-0000-0000-0000-00000000000d',
};
export const Y_ACTIVE = '10000000-0000-0000-0000-000000000001';
export const Y_ARCH   = '10000000-0000-0000-0000-000000000002';
// اسم ملف عربي قديم محفوظ كرابط public مُرمَّز
export const AR_OBJ = `${'00000000-0000-0000-0000-00000000000b'}/تقرير الأنشطة.pdf`;
export const AR_URL = 'https://x.supabase.co/storage/v1/object/public/evidences/' +
  AR_OBJ.split('/').map(encodeURIComponent).join('/');

// ---------- baseline mirroring the live project (from applied repo SQL) ----------
export async function buildBaseline(db) {
await db.exec(`
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth; CREATE SCHEMA storage;
GRANT USAGE ON SCHEMA public, auth, storage TO anon, authenticated, service_role;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT current_setting('request.jwt.claim.role', true) $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon, authenticated, service_role;

INSERT INTO auth.users VALUES ('${U.admin}','a@x'),('${U.vice}','v@x'),('${U.teacher}','t@x'),('${U.teacher2}','t2@x');

CREATE TABLE public.profiles (id uuid PRIMARY KEY REFERENCES auth.users(id), name text NOT NULL,
  username text UNIQUE, role text NOT NULL CHECK (role IN ('admin','vice','teacher')));
INSERT INTO public.profiles VALUES ('${U.admin}','القائدة','admin1','admin'),
  ('${U.vice}','الوكيلة','vice1','vice'),('${U.teacher}','المعلمة','teacher1','teacher'),
  ('${U.teacher2}','معلمة ثانية','teacher2','teacher');

CREATE FUNCTION public.current_app_role() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS
  $$ SELECT p.role FROM public.profiles p WHERE p.id = auth.uid() $$;
CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS
  $$ SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role='admin') $$;
CREATE FUNCTION public.is_staff() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS
  $$ SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','vice')) $$;

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY profiles_select ON public.profiles FOR SELECT TO authenticated USING (id = auth.uid() OR public.is_admin());
CREATE POLICY profiles_update_self ON public.profiles FOR UPDATE TO authenticated
  USING (id = auth.uid() OR public.is_admin()) WITH CHECK (id = auth.uid() OR public.is_admin());
GRANT SELECT ON public.profiles TO authenticated;
GRANT UPDATE (name, username) ON public.profiles TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;

CREATE TABLE public.school_years (id uuid PRIMARY KEY, name text, status text, is_active boolean, is_archived boolean);
INSERT INTO public.school_years VALUES ('${Y_ACTIVE}','1447','active',true,false),('${Y_ARCH}','1446','archived',false,true);
CREATE FUNCTION public.school_year_allows_write(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS
  $$ SELECT EXISTS (SELECT 1 FROM public.school_years sy WHERE sy.id=p AND sy.is_active AND NOT sy.is_archived AND sy.status='active') $$;
CREATE FUNCTION public.school_year_is_active(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS
  $$ SELECT public.school_year_allows_write(p) $$;
CREATE FUNCTION public.school_year_allows_read(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS
  $$ SELECT CASE WHEN p IS NULL THEN false
     WHEN public.is_staff() THEN EXISTS (SELECT 1 FROM public.school_years sy WHERE sy.id=p)
     WHEN public.current_app_role()='teacher' THEN public.school_year_allows_write(p)
     ELSE false END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated, service_role;
-- Supabase default: anon also has EXECUTE on public functions
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon;

CREATE TABLE public.tasks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, resp text,
  due_date date, priority text DEFAULT 'medium' CHECK (priority IN ('high','medium','low')),
  status text DEFAULT 'pending' CHECK (status IN ('pending','inprogress','done')), notes text,
  created_at timestamptz DEFAULT now(), school_year_id uuid REFERENCES public.school_years(id));
INSERT INTO public.tasks (name, resp, due_date, school_year_id) VALUES
  ('مهمة قديمة 1','المعلمة','2026-09-10','${Y_ACTIVE}'), ('مهمة قديمة 2', NULL, NULL,'${Y_ACTIVE}');
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY tasks_select ON public.tasks FOR SELECT TO authenticated
  USING (public.current_app_role() IN ('admin','vice') AND public.school_year_allows_read(school_year_id));
CREATE POLICY tasks_insert ON public.tasks FOR INSERT TO authenticated
  WITH CHECK (public.current_app_role() IN ('admin','vice') AND public.school_year_allows_write(school_year_id));
CREATE POLICY tasks_update ON public.tasks FOR UPDATE TO authenticated
  USING (public.current_app_role() IN ('admin','vice') AND public.school_year_allows_write(school_year_id))
  WITH CHECK (public.current_app_role() IN ('admin','vice') AND public.school_year_allows_write(school_year_id));
CREATE POLICY tasks_delete ON public.tasks FOR DELETE TO authenticated
  USING (public.is_admin() AND public.school_year_allows_write(school_year_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tasks TO authenticated;

CREATE TABLE public.evidences (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, title text, file_url text,
  link text, school_year_id uuid, created_by uuid);
ALTER TABLE public.evidences ENABLE ROW LEVEL SECURITY;
CREATE POLICY evidences_select ON public.evidences FOR SELECT TO authenticated
  USING (public.current_app_role() IN ('admin','vice','teacher') AND public.school_year_allows_read(school_year_id));
GRANT SELECT ON public.evidences TO authenticated;
INSERT INTO public.evidences (title, file_url, school_year_id, created_by) VALUES
  ('شاهد نشط', '${U.vice}/active.pdf', '${Y_ACTIVE}', '${U.vice}'),
  ('شاهد مؤرشف', '${U.vice}/archived.pdf', '${Y_ARCH}', '${U.vice}'),
  ('شاهد قديم URL', 'https://x.supabase.co/storage/v1/object/public/evidences/legacy/old.pdf', '${Y_ACTIVE}', NULL),
  ('شاهد عربي قديم', '${AR_URL}', '${Y_ACTIVE}', '${U.vice}');

-- evidence_requirements: reproduce the live finding (anon holds SELECT)
CREATE TABLE public.evidence_requirements (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
ALTER TABLE public.evidence_requirements ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.evidence_requirements TO anon, authenticated;
INSERT INTO public.evidence_requirements (name) VALUES ('اسم شاهد');

-- reports: worst case (unknown live state) — open policy for authenticated
CREATE TABLE public.reports (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, body text, created_at timestamptz DEFAULT now());
INSERT INTO public.reports (body) VALUES ('تقرير 1'), ('تقرير 2');
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "open all reports" ON public.reports FOR ALL TO authenticated USING (true) WITH CHECK (true);
GRANT ALL ON public.reports TO authenticated;

-- legacy login RPC closed by phase_rls_cutover (must stay closed)
CREATE FUNCTION public.authenticate_user(text, text) RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$ SELECT true $$;
REVOKE ALL ON FUNCTION public.authenticate_user(text, text) FROM PUBLIC, anon, authenticated;

-- storage
CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
INSERT INTO storage.buckets VALUES ('evidences','evidences',false,10485760,NULL);
CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text);
CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS
  $$ SELECT (string_to_array(name, '/'))[1:array_length(string_to_array(name,'/'),1)-1] $$;
GRANT EXECUTE ON FUNCTION storage.foldername(text) TO authenticated;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO authenticated;
CREATE POLICY evidences_auth_select ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id='evidences' AND public.current_app_role() IN ('admin','vice','teacher'));
INSERT INTO storage.objects (bucket_id, name) VALUES
  ('evidences','${U.vice}/active.pdf'), ('evidences','${U.vice}/archived.pdf'),
  ('evidences','legacy/old.pdf'), ('evidences','${U.teacher}/mine.pdf'), ('evidences','${AR_OBJ}');
`);
}

export function makeHelpers(db) {
  async function as(role, fn) {
    await db.exec(`RESET ROLE;`);
    const pgRole = role === 'anon' ? 'anon' : role === 'service' ? 'service_role' : 'authenticated';
    const who = (role === 'anon' || role === 'service') ? '' : U[role];
    await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', $2, false)`,
      [who, pgRole]);
    await db.exec(`SET ROLE ${pgRole};`);
    try { return await fn(); } finally { await db.exec(`RESET ROLE;`); }
  }
  async function tryQ(sql, params = []) {
    try { const r = await db.query(sql, params); return { rows: r.rows, affected: r.affectedRows ?? 0 }; }
    catch (e) { return { error: e.message }; }
  }
  const runMigration = (file) => db.exec(readFileSync(`${REPO}/sql/${file}`, 'utf8'));
  return { as, tryQ, runMigration };
}

async function precheckReport(db) {
  const r = await db.exec(readFileSync(`${REPO}/sql/precheck_readonly_report.sql`, 'utf8'));
  return JSON.parse(r[r.length - 1].rows[0].report);
}

if (isMain) {
const db = new PGlite();
await buildBaseline(db);
const { as, tryQ, runMigration } = makeHelpers(db);
const apply = async (file) => {
  try { await runMigration(file); ok(`applied ${file}`, true); }
  catch (e) { ok(`applied ${file}`, false, e.message); }
};

// ---------- step 0: read-only precheck report ----------
console.log('\n== Step 0: precheck_readonly_report.sql ==');
let rep;
try { rep = await precheckReport(db); ok('precheck returns single JSON report', !!rep.S1_reports); }
catch (e) { ok('precheck returns single JSON report', false, e.message); }
if (rep) {
  ok('precheck: no STOP on baseline', Array.isArray(rep.stop) && rep.stop.length === 0, JSON.stringify(rep.stop));
  ok('precheck S1: reports row_count + policy captured',
    rep.S1_reports.activity.row_count === 2 && rep.S1_reports.policies.length === 1, JSON.stringify(rep.S1_reports.activity));
  ok('precheck S3: open reports policy flagged', rep.S3_open_or_anon_policies.some(p => p.table === 'reports'));
  ok('precheck S4: anon grant on evidence_requirements flagged',
    Object.keys(rep.S4_anon_public_table_grants).some(k => k === 'anon:evidence_requirements'));
  const s7 = rep.S7_storage_teacher_read_impact;
  ok('precheck S7: 0 files would be cut (incl. encoded Arabic legacy URL)',
    s7.active_year_file_evidences === 3 && s7.object_found_by_new_key === 3 && s7.WOULD_BE_CUT_old_match_but_not_new_key === 0,
    JSON.stringify(s7));
  ok('precheck S9: task counts, no name matching', rep.S9_tasks_readiness.tasks_active_year === 2
    && rep.S9_tasks_readiness.tasks_with_resp === 1 && !('resp_exact_unique_teacher_match' in rep.S9_tasks_readiness),
    JSON.stringify(rep.S9_tasks_readiness));
  const txt = JSON.stringify(rep);
  ok('precheck output has no names/emails/file paths', !txt.includes('المعلمة') && !txt.includes('@x') && !txt.includes('active.pdf'));
  const tmp = await db.query(`SELECT count(*)::int c FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname NOT LIKE 'pg_temp%' AND p.proname IN ('ev_key','s7','s9','reports_activity')`);
  ok('precheck leaves no persistent objects', tmp.rows[0].c === 0);
}

// ---------- BEFORE: reproduce findings ----------
console.log('\n== BEFORE (reproduce findings) ==');
await as('anon', async () => {
  const r = await tryQ(`SELECT count(*)::int c FROM public.evidence_requirements`);
  ok('finding: anon can query evidence_requirements', !r.error, JSON.stringify(r));
});
await as('teacher', async () => {
  const u = await tryQ(`UPDATE public.profiles SET name='القائدة' WHERE id=$1`, [U.teacher]);
  ok('finding: teacher can rename own profile', !u.error && u.affected === 1, JSON.stringify(u));
  const s = await tryQ(`SELECT name FROM storage.objects WHERE name LIKE '%archived%'`);
  ok('finding: teacher sees archived-year storage object', s.rows?.length === 1, JSON.stringify(s));
});
await db.exec(`UPDATE public.profiles SET name='المعلمة' WHERE id='${U.teacher}'`);

// ---------- step 1: security hardening ----------
console.log('\n== Step 1: security hardening ==');
await apply('phase_security_hardening_review.sql');
await as('service', async () => {
  const r = await tryQ(`SELECT public.is_admin() AS a`);
  ok('service_role keeps EXECUTE on SECURITY DEFINER helpers', !r.error, JSON.stringify(r));
});

// ---------- step 2: tasks expand ----------
console.log('\n== Step 2: tasks expand (compatible with OLD frontend) ==');
await apply('phase_task_schedule_evidence_review.sql');
await as('vice', async () => {
  const r = await tryQ(`INSERT INTO public.tasks (name, resp, due_date, priority, status, notes, school_year_id)
    VALUES ('من الواجهة القديمة','x','2026-10-05','high','pending',NULL,$1) RETURNING id`, [Y_ACTIVE]);
  ok('OLD frontend insert (no times) still works between steps 2 and 4', !r.error && r.rows.length === 1, JSON.stringify(r));
});

console.log('\n== Idempotency: re-run steps 1-2 ==');
try { await runMigration('phase_security_hardening_review.sql'); await runMigration('phase_task_schedule_evidence_review.sql'); ok('re-run OK', true); }
catch (e) { ok('re-run OK', false, e.message); }

// ---------- data preserved ----------
console.log('\n== Data preservation ==');
{
  const r = await db.query(`SELECT count(*) FILTER (WHERE name LIKE 'مهمة قديمة%')::int c,
    count(*) FILTER (WHERE name LIKE 'مهمة قديمة%' AND start_at IS NULL AND end_at IS NULL)::int legacy,
    count(*) FILTER (WHERE due_date = '2026-09-10')::int due,
    count(*) FILTER (WHERE name = 'مهمة قديمة 1' AND resp = 'المعلمة')::int resp FROM public.tasks`);
  ok('legacy tasks kept, times NULL, due_date and «المسؤولة» untouched',
    r.rows[0].c === 2 && r.rows[0].legacy === 2 && r.rows[0].due === 1 && r.rows[0].resp === 1, JSON.stringify(r.rows));
  const col = await db.query(`SELECT count(*)::int c FROM information_schema.columns WHERE table_name='tasks' AND column_name='assignee_id'`);
  ok('no per-teacher assignment column (shared account model)', col.rows[0].c === 0);
  const rp = await db.query(`SELECT count(*)::int c FROM public.reports`);
  ok('reports rows kept (2)', rp.rows[0].c === 2);
  const ob = await db.query(`SELECT count(*)::int c FROM storage.objects`);
  ok('storage objects kept (5)', ob.rows[0].c === 5);
}

// ---------- tasks: schedule + drive evidence (admin/vice) ----------
console.log('\n== Tasks: schedule & Drive evidence (vice/admin) ==');
const S = '2026-10-01T06:00:00Z', E = '2026-10-01T09:30:00Z';
let taskId;
await as('vice', async () => {
  let r = await tryQ(`INSERT INTO public.tasks (name, resp, school_year_id, start_at, end_at, due_date, evidence_drive_url, evidence_title)
    VALUES ('مهمة جديدة','أ. نورة',$1,$2,$3,'2026-10-01','https://drive.google.com/file/d/abc/view','محضر') RETURNING id, evidence_added_by, evidence_approved`,
    [Y_ACTIVE, S, E]);
  ok('vice adds task with start/end + Drive link + «المسؤولة»', !r.error && r.rows[0].evidence_added_by === U.vice && r.rows[0].evidence_approved === false, JSON.stringify(r));
  taskId = r.rows?.[0]?.id;

  r = await tryQ(`INSERT INTO public.tasks (name, school_year_id, start_at, end_at) VALUES ('معكوسة',$1,$2,$3)`, [Y_ACTIVE, E, S]);
  ok('end before start rejected', !!r.error && r.error.includes('tasks_schedule_order_check'), JSON.stringify(r));

  r = await tryQ(`INSERT INTO public.tasks (name, school_year_id, start_at, end_at) VALUES ('متساوية',$1,$2,$2)`, [Y_ACTIVE, S]);
  ok('end equal to start rejected', !!r.error && r.error.includes('tasks_schedule_order_check'), JSON.stringify(r));

  for (const bad of ['http://drive.google.com/x', 'https://evil.example/x', 'javascript:alert(1)',
                     'https://drive.google.com.evil.com/x', 'https://drive.google.com/x"><script>']) {
    r = await tryQ(`UPDATE public.tasks SET evidence_drive_url=$1 WHERE id=$2`, [bad, taskId]);
    ok(`invalid Drive URL rejected: ${bad}`, !!r.error, JSON.stringify(r));
  }

  r = await tryQ(`UPDATE public.tasks SET start_at=$1, end_at=$2 WHERE id=$3 RETURNING start_at, end_at`,
    ['2026-10-02T05:00:00Z', '2026-10-02T07:00:00Z', taskId]);
  ok('vice edits task times', !r.error && r.affected === 1, JSON.stringify(r));

  r = await tryQ(`UPDATE public.tasks SET start_at=NULL WHERE id=$1`, [taskId]);
  ok('clearing only one time rejected', !!r.error && r.error.includes('tasks_schedule_pair_check'), JSON.stringify(r));

  r = await tryQ(`UPDATE public.tasks SET evidence_approved=true WHERE id=$1`, [taskId]);
  ok('vice cannot approve task evidence', !!r.error && r.error.includes('فقط القائدة'), JSON.stringify(r));

  r = await tryQ(`UPDATE public.tasks SET evidence_approved_by=$1, evidence_approved_at=now() WHERE id=$2`, [U.vice, taskId]);
  ok('vice cannot forge approval columns', !!r.error, JSON.stringify(r));

  r = await tryQ(`UPDATE public.tasks SET status='inprogress' WHERE name='مهمة قديمة 1'`);
  ok('legacy task (no times) still editable', !r.error && r.affected === 1, JSON.stringify(r));

  r = await tryQ(`DELETE FROM public.tasks WHERE id=$1`, [taskId]);
  ok('vice cannot delete task (0 rows)', !r.error && r.affected === 0, JSON.stringify(r));
});

// ---------- shared teacher account: evidence on any visible active-year task ----------
console.log('\n== Shared teacher account: Drive evidence on active-year tasks ==');
await db.exec(`INSERT INTO public.tasks (name, resp, school_year_id) VALUES ('مهمة سنة مؤرشفة','المعلمة','${Y_ARCH}')`);
await db.exec(`INSERT INTO public.tasks (name, resp, school_year_id, evidence_drive_url, evidence_approved) VALUES
  ('مهمة شاهدها معتمد','أ. هند','${Y_ACTIVE}','https://drive.google.com/approved', false)`);
await as('admin', async () => {
  const r = await tryQ(`UPDATE public.tasks SET evidence_approved=true WHERE name='مهمة شاهدها معتمد'`);
  ok('setup: admin approves one task evidence', !r.error && r.affected === 1, JSON.stringify(r));
});
{
  const exp = (await db.query(`SELECT count(*)::int c FROM public.tasks WHERE school_year_id = $1`, [Y_ACTIVE])).rows[0].c;
  await as('teacher', async () => {
    let r = await tryQ(`SELECT name, resp, school_year_id FROM public.tasks`);
    ok(`shared account sees all ${exp} active-year tasks, none archived`,
      r.rows?.length === exp && r.rows.every(t => t.school_year_id === Y_ACTIVE), JSON.stringify(r));
    ok('shared account sees «المسؤولة» of each task', r.rows?.some(t => t.resp === 'أ. نورة') && r.rows?.some(t => t.resp === 'المعلمة'), JSON.stringify(r.rows));

    r = await tryQ(`UPDATE public.tasks SET evidence_drive_url='https://drive.google.com/file/d/teacher/view', evidence_title='صور التنفيذ'
      WHERE id=$1 RETURNING evidence_added_by, evidence_approved, resp`, [taskId]);
    ok('shared account attaches Drive evidence (stamped with shared account id, unapproved, resp unchanged)',
      !r.error && r.rows?.[0]?.evidence_added_by === U.teacher && r.rows[0].evidence_approved === false && r.rows[0].resp === 'أ. نورة', JSON.stringify(r));
    r = await tryQ(`UPDATE public.tasks SET evidence_drive_url='https://docs.google.com/document/d/legacy' WHERE name='مهمة قديمة 2' RETURNING id`);
    ok('shared account attaches evidence to a legacy untimed task', !r.error && r.affected === 1, JSON.stringify(r));
    r = await tryQ(`UPDATE public.tasks SET evidence_drive_url='https://drive.google.com/file/d/fixed/view' WHERE id=$1`, [taskId]);
    ok('shared account can replace an unapproved link', !r.error && r.affected === 1, JSON.stringify(r));
    r = await tryQ(`UPDATE public.tasks SET evidence_drive_url=NULL WHERE id=$1`, [taskId]);
    ok('shared account cannot delete an attached link', !!r.error, JSON.stringify(r));
    r = await tryQ(`UPDATE public.tasks SET evidence_drive_url='https://evil.example/x' WHERE id=$1`, [taskId]);
    ok('shared account: invalid URL rejected', !!r.error, JSON.stringify(r));
    for (const [col, val] of [['status', `'done'`], ['name', `'x'`], ['start_at', `start_at + interval '1 hour'`],
                              ['end_at', `end_at + interval '1 hour'`], ['resp', `'x'`], ['priority', `'low'`],
                              ['notes', `'x'`], ['due_date', `'2030-01-01'`], ['school_year_id', `'${Y_ARCH}'`],
                              ['evidence_approved', 'true'], ['evidence_approved_by', `'${U.teacher}'`]]) {
      r = await tryQ(`UPDATE public.tasks SET ${col}=${val} WHERE id=$1`, [taskId]);
      ok(`shared account cannot change ${col}`, !!r.error, JSON.stringify(r));
    }
    r = await tryQ(`UPDATE public.tasks SET evidence_drive_url='https://drive.google.com/x' WHERE name='مهمة سنة مؤرشفة'`);
    ok('shared account cannot attach to archived-year task (0 rows)', !r.error && r.affected === 0, JSON.stringify(r));
    r = await tryQ(`UPDATE public.tasks SET evidence_drive_url='https://drive.google.com/other' WHERE name='مهمة شاهدها معتمد'`);
    ok('shared account cannot change approved evidence (0 rows)', !r.error && r.affected === 0, JSON.stringify(r));
    r = await tryQ(`INSERT INTO public.tasks (name, school_year_id, start_at, end_at) VALUES ('x',$1,$2,$3)`, [Y_ACTIVE, S, E]);
    ok('shared account cannot insert task', !!r.error, JSON.stringify(r));
    r = await tryQ(`DELETE FROM public.tasks WHERE id=$1`, [taskId]);
    ok('shared account cannot delete task (0 rows)', !r.error && r.affected === 0, JSON.stringify(r));
  });
  const a = (await db.query(`SELECT evidence_drive_url FROM public.tasks WHERE name='مهمة شاهدها معتمد'`)).rows[0];
  ok('approved evidence unchanged in DB', a.evidence_drive_url === 'https://drive.google.com/approved');
  const ar = (await db.query(`SELECT evidence_drive_url FROM public.tasks WHERE name='مهمة سنة مؤرشفة'`)).rows[0];
  ok('archived-year task unchanged in DB', ar.evidence_drive_url === null);
}

await as('admin', async () => {
  let r = await tryQ(`UPDATE public.tasks SET evidence_title='x', evidence_drive_url=NULL, evidence_approved=true WHERE id=$1`, [taskId]);
  ok('approval without link rejected', !!r.error, JSON.stringify(r));
  r = await tryQ(`UPDATE public.tasks SET evidence_approved=true WHERE id=$1 RETURNING evidence_approved_by, evidence_added_by`, [taskId]);
  ok('admin (leader) approves shared-account evidence', !r.error && r.rows[0].evidence_approved_by === U.admin && r.rows[0].evidence_added_by === U.teacher, JSON.stringify(r));
});
await as('teacher', async () => {
  const r = await tryQ(`UPDATE public.tasks SET evidence_drive_url='https://drive.google.com/new' WHERE id=$1`, [taskId]);
  ok('approved evidence locked for shared account (0 rows)', !r.error && r.affected === 0, JSON.stringify(r));
});
await as('vice', async () => {
  let r = await tryQ(`UPDATE public.tasks SET evidence_drive_url='https://docs.google.com/document/d/zz' WHERE id=$1`, [taskId]);
  ok('approved evidence locked for vice', !!r.error && r.error.includes('ألغِ الاعتماد'), JSON.stringify(r));
  r = await tryQ(`UPDATE public.tasks SET evidence_approved=false WHERE id=$1`, [taskId]);
  ok('vice cannot revoke approval', !!r.error, JSON.stringify(r));
  r = await tryQ(`UPDATE public.tasks SET status='done' WHERE id=$1`, [taskId]);
  ok('vice can still change status of task with approved evidence', !r.error && r.affected === 1, JSON.stringify(r));
});
await as('admin', async () => {
  const r = await tryQ(`UPDATE public.tasks SET evidence_approved=false, evidence_drive_url='https://docs.google.com/document/d/zz'
    WHERE id=$1 RETURNING evidence_approved, evidence_approved_by, evidence_added_by`, [taskId]);
  ok('admin unapproves + replaces link', !r.error && r.rows[0].evidence_approved === false && r.rows[0].evidence_approved_by === null && r.rows[0].evidence_added_by === U.admin, JSON.stringify(r));
});

// ---------- step 4: enforce times on insert ----------
console.log('\n== Step 4: enforce times on insert (after frontend deploy) ==');
await apply('phase_task_schedule_enforce_review.sql');
await as('vice', async () => {
  let r = await tryQ(`INSERT INTO public.tasks (name, school_year_id) VALUES ('بلا وقت',$1)`, [Y_ACTIVE]);
  ok('new task without times rejected after step 4', !!r.error && r.error.includes('البداية والنهاية'), JSON.stringify(r));
  r = await tryQ(`INSERT INTO public.tasks (name, school_year_id, start_at, end_at) VALUES ('بوقت',$1,$2,$3)`, [Y_ACTIVE, S, E]);
  ok('new task with times accepted after step 4', !r.error, JSON.stringify(r));
  r = await tryQ(`UPDATE public.tasks SET notes='ملاحظة' WHERE name='مهمة قديمة 2'`);
  ok('legacy untimed task still editable after step 4', !r.error && r.affected === 1, JSON.stringify(r));
});

// ---------- step 5: login throttle (shared teacher account, one school network) ----------
console.log('\n== Step 5: login throttle ==');
await apply('phase_login_throttle_review.sql');
const hx = (tag) => tag.padStart(64, '0');
const USER = hx('1111'), SCHOOL = hx('5c'), HOME = hx('40e'), PAIR_SCHOOL = hx('a5'), PAIR_HOME = hx('a40');
const begin = (u, ip, pr) => tryQ(`SELECT public.login_throttle_begin($1, $2, $3) AS r`, [u, ip, pr]);
const success = (pr, id) => tryQ(`SELECT public.login_throttle_success($1, $2::uuid)`, [pr, id]);
await as('service', async () => {
  let r;
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 9; i++) await begin(USER, SCHOOL, PAIR_SCHOOL);
    r = await begin(USER, SCHOOL, PAIR_SCHOOL);
    await success(PAIR_SCHOOL, r.rows[0].r.attempt_id);
  }
  ok('school: 27 scattered typos across the day never lock (each success resets the school counter)', r.rows?.[0]?.r?.allowed === true, JSON.stringify(r));

  for (let i = 0; i < 10; i++) r = await begin(USER, SCHOOL, PAIR_SCHOOL);
  ok('school: 10 consecutive failures allowed', r.rows?.[0]?.r?.allowed === true, JSON.stringify(r));
  r = await begin(USER, SCHOOL, PAIR_SCHOOL);
  ok('school: 11th consecutive failure → blocked with retry_after ≤ 900s',
    r.rows?.[0]?.r?.allowed === false && r.rows[0].r.retry_after > 0 && r.rows[0].r.retry_after <= 900, JSON.stringify(r));
  r = await begin(USER, HOME, PAIR_HOME);
  ok('same shared account from another network still allowed (school lock is local)', r.rows?.[0]?.r?.allowed === true, JSON.stringify(r));
  r = await begin(hx('2222'), SCHOOL, hx('b5'));
  ok('admin/vice username from the school network still allowed', r.rows?.[0]?.r?.allowed === true, JSON.stringify(r));
  r = await tryQ(`SELECT public.login_throttle_begin($1, $2, $3) AS r`, ['not-a-hash', SCHOOL, PAIR_SCHOOL]);
  ok('raw (unhashed) key rejected', !!r.error, JSON.stringify(r));
  const t = await tryQ(`SELECT count(*) FROM private.login_attempts`);
  ok('service_role has no direct table access (functions only)', !!t.error, JSON.stringify(t));
});
await db.exec(`UPDATE private.login_attempts SET attempted_at = attempted_at - interval '16 minutes' WHERE key = 'pr:${PAIR_SCHOOL}'`);
await as('service', async () => {
  const r = await begin(USER, SCHOOL, PAIR_SCHOOL);
  ok('school unblocked after the 15-minute window', r.rows?.[0]?.r?.allowed === true, JSON.stringify(r));
});
{
  // distributed guessing: 100 failures from 20 networks → username capped everywhere
  await db.exec(`DELETE FROM private.login_attempts`);
  for (let n = 0; n < 20; n++) for (let i = 0; i < 5; i++)
    await db.query(`SELECT public.login_throttle_begin($1, $2, $3)`, [USER, hx('e' + n.toString(16)), hx('f' + n.toString(16))]);
  const r = await db.query(`SELECT public.login_throttle_begin($1, $2, $3) AS r`, [USER, hx('ee'), hx('fe')]);
  ok('username cap: 100 failures from many networks → blocked (distributed guessing)', r.rows[0].r.allowed === false, JSON.stringify(r.rows));

  await db.exec(`DELETE FROM private.login_attempts`);
  for (let i = 0; i < 200; i++)
    await db.query(`SELECT public.login_throttle_begin($1, $2, $3)`, [hx('c' + i.toString(16)), SCHOOL, hx('d' + i.toString(16))]);
  const r2 = await db.query(`SELECT public.login_throttle_begin($1, $2, $3) AS r`, [hx('cfff'), SCHOOL, hx('dfff')]);
  ok('network cap: 200 failures across usernames from one network → blocked (spraying)', r2.rows[0].r.allowed === false, JSON.stringify(r2.rows));
  await db.exec(`DELETE FROM private.login_attempts`);
}
for (const role of ['anon', 'teacher', 'admin']) {
  await as(role, async () => {
    const r = await tryQ(`SELECT public.login_throttle_begin($1, $2, $3)`, [USER, SCHOOL, PAIR_SCHOOL]);
    ok(`${role} cannot call login_throttle_begin`, !!r.error, JSON.stringify(r));
    const t = await tryQ(`SELECT count(*) FROM private.login_attempts`);
    ok(`${role} cannot read private.login_attempts`, !!t.error, JSON.stringify(t));
  });
}

// ---------- step 6: storage teacher read ----------
console.log('\n== Step 6: storage teacher read ==');
await apply('phase_storage_teacher_read_review.sql');

// ---------- role isolation (final state) ----------
console.log('\n== Role isolation (after all steps) ==');
await as('teacher', async () => {
  let r = await tryQ(`UPDATE public.profiles SET name='القائدة' WHERE id=$1`, [U.teacher]);
  ok('teacher cannot rename profile', !!r.error, JSON.stringify(r));
  r = await tryQ(`SELECT role FROM public.profiles WHERE id=$1`, [U.teacher]);
  ok('teacher can still read own profile (login works)', r.rows?.[0]?.role === 'teacher', JSON.stringify(r));

  r = await tryQ(`SELECT name FROM storage.objects ORDER BY name`);
  const names = (r.rows || []).map(x => x.name);
  ok('teacher storage: active-year file visible', names.includes(`${U.vice}/active.pdf`), JSON.stringify(names));
  ok('teacher storage: own folder visible', names.includes(`${U.teacher}/mine.pdf`), JSON.stringify(names));
  ok('teacher storage: legacy full-URL active file visible', names.includes('legacy/old.pdf'), JSON.stringify(names));
  ok('teacher storage: URL-encoded Arabic legacy file visible', names.includes(AR_OBJ), JSON.stringify(names));
  ok('teacher storage: archived-year file hidden', !names.includes(`${U.vice}/archived.pdf`), JSON.stringify(names));

  r = await tryQ(`SELECT count(*)::int c FROM public.reports`);
  ok('reports untouched pending S1 decision (worst-case policy still in effect)', r.rows?.[0]?.c === 2, JSON.stringify(r));
});
await as('vice', async () => {
  let r = await tryQ(`SELECT count(*)::int c FROM storage.objects`);
  ok('vice sees all 5 storage objects', r.rows?.[0]?.c === 5, JSON.stringify(r));
  r = await tryQ(`UPDATE public.profiles SET role='admin' WHERE id=$1`, [U.vice]);
  ok('vice cannot escalate role', !!r.error, JSON.stringify(r));
});
await as('admin', async () => {
  let r = await tryQ(`SELECT count(*)::int c FROM storage.objects`);
  ok('admin sees all storage objects', r.rows?.[0]?.c === 5, JSON.stringify(r));
  r = await tryQ(`SELECT public.authenticate_user('a','b')`);
  ok('legacy closed RPC not re-opened for authenticated', !!r.error, JSON.stringify(r));
  r = await tryQ(`SELECT public.is_admin() AS a`);
  ok('authenticated keeps EXECUTE on role helpers', r.rows?.[0]?.a === true, JSON.stringify(r));
});
await as('anon', async () => {
  for (const t of ['tasks', 'reports', 'evidence_requirements', 'profiles', 'evidences']) {
    const r = await tryQ(`SELECT 1 FROM public.${t} LIMIT 1`);
    ok(`anon denied on ${t}`, !!r.error && r.error.includes('permission denied'), JSON.stringify(r));
  }
  let r = await tryQ(`SELECT public.is_admin()`);
  ok('anon cannot execute public functions', !!r.error, JSON.stringify(r));
  r = await tryQ(`UPDATE public.tasks SET evidence_drive_url='https://drive.google.com/x'`);
  ok('anon cannot attach task evidence', !!r.error, JSON.stringify(r));
});

// ---------- rollbacks ----------
console.log('\n== Rollback blocks execute cleanly ==');
const rollbackOf = (file) => {
  const src = readFileSync(`${REPO}/sql/${file}`, 'utf8');
  const m = [...src.matchAll(/\/\*\s*\n(BEGIN;[\s\S]*?COMMIT;)[\s\S]*?\*\//g)];
  return m.length ? m[m.length - 1][1] : null;
};
for (const f of ['phase_storage_teacher_read_review.sql', 'phase_login_throttle_review.sql', 'phase_task_schedule_enforce_review.sql']) {
  const sql = rollbackOf(f);
  try { if (!sql) throw new Error('no rollback block'); await db.exec(sql); ok(`rollback ${f}`, true); }
  catch (e) { ok(`rollback ${f}`, false, e.message); }
}
{
  const r = await db.query(`SELECT count(*)::int c FROM public.tasks`);
  ok('rollbacks did not delete task rows', r.rows[0].c >= 5, JSON.stringify(r.rows));
}

// ---------- reports draft (not in apply order): verify on a fresh DB ----------
console.log('\n== Draft phase_reports_lockdown_review.sql (fresh DB, not in apply order) ==');
{
  const db2 = new PGlite();
  await buildBaseline(db2);
  const h = makeHelpers(db2);
  try { await h.runMigration('phase_reports_lockdown_review.sql'); ok('draft applies', true); }
  catch (e) { ok('draft applies', false, e.message); }
  await h.as('teacher', async () => {
    const r = await h.tryQ(`SELECT count(*)::int c FROM public.reports`);
    ok('draft: teacher sees 0 reports', r.rows?.[0]?.c === 0, JSON.stringify(r));
  });
  await h.as('admin', async () => {
    let r = await h.tryQ(`SELECT count(*)::int c FROM public.reports`);
    ok('draft: admin reads reports', r.rows?.[0]?.c === 2, JSON.stringify(r));
    r = await h.tryQ(`INSERT INTO public.reports (body) VALUES ('x')`);
    ok('draft: client writes blocked', !!r.error, JSON.stringify(r));
  });
  const rp = await db2.query(`SELECT count(*)::int c FROM public.reports`);
  ok('draft: rows kept', rp.rows[0].c === 2);
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
}
