-- Math Task Studio: безопасная общая база задач
-- Выполнить целиком в Supabase Dashboard → SQL Editor → New query.

create extension if not exists pgcrypto;

create table if not exists public.tasks (
  id text primary key,
  title text not null,
  category text not null,
  difficulty text not null check (difficulty in ('Лёгкая','Средняя','Сложная')),
  condition text not null,
  hints jsonb not null default '[]'::jsonb,
  answer text not null,
  tolerance numeric not null default 0 check (tolerance >= 0),
  explanation text not null default '',
  published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.tasks enable row level security;
-- Намеренно не создаём policies на прямое чтение/запись таблицы.
-- Доступ выполняется только через контролируемые RPC-функции ниже.
revoke all on public.tasks from anon, authenticated;

grant usage on schema public to anon, authenticated;

create or replace function public.is_math_task_teacher()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from auth.users u
    where u.id = (select auth.uid())
      and lower(coalesce(u.email,'')) = 'kostyleva-2000@bk.ru'
  );
$$;
revoke all on function public.is_math_task_teacher() from public, anon, authenticated;

create or replace function public.list_published_tasks()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',t.id,'title',t.title,'category',t.category,'difficulty',t.difficulty,
    'condition',t.condition,'hints',t.hints
  ) order by t.created_at, t.title), '[]'::jsonb)
  from public.tasks t where t.published = true;
$$;

create or replace function public.check_task_answer(p_task_id text, p_submitted_answer text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task public.tasks%rowtype;
  v_correct boolean := false;
  v_expected numeric;
  v_actual numeric;
begin
  select * into v_task from public.tasks where id = p_task_id and published = true;
  if not found then
    return jsonb_build_object('correct', false, 'message', 'Задача не найдена');
  end if;
  if p_submitted_answer is null or length(trim(p_submitted_answer)) = 0 then
    return jsonb_build_object('correct', false);
  end if;
  -- Числовые ответы сравниваются с учётом допустимой погрешности.
  if trim(replace(p_submitted_answer, ',', '.')) ~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$'
     and trim(replace(v_task.answer, ',', '.')) ~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$' then
    v_actual := trim(replace(p_submitted_answer, ',', '.'))::numeric;
    v_expected := trim(replace(v_task.answer, ',', '.'))::numeric;
    v_correct := abs(v_actual - v_expected) <= v_task.tolerance;
  else
    v_correct := lower(trim(p_submitted_answer)) = lower(trim(v_task.answer));
  end if;
  if v_correct then
    return jsonb_build_object('correct', true, 'explanation', v_task.explanation);
  end if;
  return jsonb_build_object('correct', false);
end;
$$;

create or replace function public.admin_list_tasks()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_math_task_teacher() then raise exception 'not_authorized'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
    'id',t.id,'title',t.title,'category',t.category,'difficulty',t.difficulty,
    'condition',t.condition,'hints',t.hints,'answer',t.answer,'tolerance',t.tolerance,
    'explanation',t.explanation,'published',t.published
  ) order by t.created_at desc), '[]'::jsonb) from public.tasks t);
end;
$$;

create or replace function public.admin_save_task(p_task jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_id text;
begin
  if not public.is_math_task_teacher() then raise exception 'not_authorized'; end if;
  v_id := coalesce(nullif(p_task->>'id',''), gen_random_uuid()::text);
  insert into public.tasks(id,title,category,difficulty,condition,hints,answer,tolerance,explanation,published,updated_at)
  values (
    v_id,
    coalesce(p_task->>'title',''),
    coalesce(p_task->>'category',''),
    coalesce(p_task->>'difficulty','Лёгкая'),
    coalesce(p_task->>'condition',''),
    coalesce(p_task->'hints','[]'::jsonb),
    coalesce(p_task->>'answer',''),
    greatest(coalesce(nullif(p_task->>'tolerance','')::numeric,0),0),
    coalesce(p_task->>'explanation',''),
    coalesce((p_task->>'published')::boolean,false),
    now()
  )
  on conflict(id) do update set
    title=excluded.title, category=excluded.category, difficulty=excluded.difficulty,
    condition=excluded.condition, hints=excluded.hints, answer=excluded.answer,
    tolerance=excluded.tolerance, explanation=excluded.explanation,
    published=excluded.published, updated_at=now();
  return jsonb_build_object('ok',true,'id',v_id);
end;
$$;

create or replace function public.admin_delete_task(p_task_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_math_task_teacher() then raise exception 'not_authorized'; end if;
  delete from public.tasks where id=p_task_id;
  return jsonb_build_object('ok',true);
end;
$$;

revoke all on function public.list_published_tasks() from public;
revoke all on function public.check_task_answer(text,text) from public;
revoke all on function public.admin_list_tasks() from public;
revoke all on function public.admin_save_task(jsonb) from public;
revoke all on function public.admin_delete_task(text) from public;
grant execute on function public.list_published_tasks() to anon, authenticated;
grant execute on function public.check_task_answer(text,text) to anon, authenticated;
grant execute on function public.admin_list_tasks() to authenticated;
grant execute on function public.admin_save_task(jsonb) to authenticated;
grant execute on function public.admin_delete_task(text) to authenticated;

-- Стартовые задачи. Повторный запуск скрипта не создаёт дубликаты.
insert into public.tasks(id,title,category,difficulty,condition,hints,answer,tolerance,explanation,published)
values
('sample-1','Покупка строительных материалов','Практика','Лёгкая','В магазине купили 4 мешка цемента по 350 рублей за каждый. Сколько рублей заплатили за все мешки?','["Чтобы узнать общую стоимость, умножь цену одного мешка на количество мешков.","Выполни умножение 350 × 4."]'::jsonb,'1400',0,'350 × 4 = 1400 рублей.\nОтвет: 1400 рублей.',true),
('sample-2','Плитка для пола','Строительство','Средняя','Для пола одной комнаты нужно 24 плитки. Сколько плиток понадобится для трёх одинаковых комнат?','["Количество плиток в одной комнате нужно умножить на количество комнат.","Вычисли 24 × 3."]'::jsonb,'72',0,'24 × 3 = 72 плитки.\nОтвет: 72 плитки.',true),
('sample-3','Длина ограждения','Практика','Лёгкая','Прямоугольный участок имеет длину 12 метров и ширину 8 метров. Сколько метров ограждения понадобится, чтобы огородить участок по всему периметру?','["Периметр прямоугольника — это сумма длин всех его сторон.","Можно сложить длину и ширину и умножить сумму на 2."]'::jsonb,'40',0,'P = (12 + 8) × 2 = 40 метров.\nОтвет: 40 метров.',true)
on conflict(id) do nothing;

-- Email Auth: после выполнения SQL откройте Authentication → URL Configuration.
-- Добавьте URL опубликованного сайта в Site URL и Redirect URLs.
-- В Authentication → Providers → Email оставьте включённым Email OTP / Magic Link.
