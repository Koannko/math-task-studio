-- Math Task Studio: общая база задач с закрытыми ответами и доступом учителя.
-- Запустить целиком в Supabase Dashboard -> SQL Editor -> New query.
-- Скрипт рассчитан на новый проект/первую установку.

create table if not exists public.tasks (
  id text primary key,
  title text not null,
  category text not null,
  difficulty text not null check (difficulty in ('Лёгкая', 'Средняя', 'Сложная')),
  condition text not null,
  hints jsonb not null default '[]'::jsonb check (jsonb_typeof(hints) = 'array'),
  answer text not null,
  tolerance numeric not null default 0 check (tolerance >= 0),
  explanation text not null default '',
  published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.tasks enable row level security;
-- Таблица не читается и не изменяется напрямую из браузера.
revoke all on table public.tasks from anon, authenticated;
grant usage on schema public to anon, authenticated;

-- Внутренняя проверка единственного разрешённого email учителя.
create or replace function public.is_math_task_teacher()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from auth.users as u
    where u.id = (select auth.uid())
      and lower(coalesce(u.email, '')) = 'kostyleva-2000@bk.ru'
  );
$$;
revoke all on function public.is_math_task_teacher() from public, anon, authenticated;

-- Ученику возвращаются только опубликованные задачи без ответа и погрешности.
create or replace function public.list_published_tasks()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', t.id,
        'title', t.title,
        'category', t.category,
        'difficulty', t.difficulty,
        'condition', t.condition,
        'hints', t.hints
      ) order by t.created_at, t.title
    ),
    '[]'::jsonb
  )
  from public.tasks as t
  where t.published = true;
$$;

-- Ответ проверяется на сервере; правильный ответ не отправляется ученику.
create or replace function public.check_task_answer(
  p_task_id text,
  p_submitted_answer text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.tasks%rowtype;
  v_correct boolean := false;
  v_expected numeric;
  v_actual numeric;
  v_submitted text;
  v_answer text;
begin
  select * into v_task
  from public.tasks as t
  where t.id = p_task_id and t.published = true;

  if not found then
    return jsonb_build_object('correct', false, 'message', 'Задача не найдена');
  end if;

  v_submitted := trim(coalesce(p_submitted_answer, ''));
  v_answer := trim(coalesce(v_task.answer, ''));
  if v_submitted = '' or length(v_submitted) > 100 then
    return jsonb_build_object('correct', false);
  end if;

  if replace(v_submitted, ',', '.') ~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$'
     and replace(v_answer, ',', '.') ~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$' then
    begin
      v_actual := replace(v_submitted, ',', '.')::numeric;
      v_expected := replace(v_answer, ',', '.')::numeric;
      v_correct := abs(v_actual - v_expected) <= v_task.tolerance;
    exception when numeric_value_out_of_range or invalid_text_representation then
      v_correct := false;
    end;
  else
    v_correct := lower(v_submitted) = lower(v_answer);
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
set search_path = ''
as $$
begin
  if not public.is_math_task_teacher() then
    raise exception 'not_authorized';
  end if;

  return (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', t.id,
          'title', t.title,
          'category', t.category,
          'difficulty', t.difficulty,
          'condition', t.condition,
          'hints', t.hints,
          'answer', t.answer,
          'tolerance', t.tolerance,
          'explanation', t.explanation,
          'published', t.published
        ) order by t.created_at desc
      ),
      '[]'::jsonb
    )
    from public.tasks as t
  );
end;
$$;

create or replace function public.admin_save_task(p_task jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id text;
  v_hints jsonb;
  v_tolerance numeric;
begin
  if not public.is_math_task_teacher() then
    raise exception 'not_authorized';
  end if;
  if p_task is null or jsonb_typeof(p_task) <> 'object' then
    raise exception 'invalid_task';
  end if;
  if coalesce(trim(p_task->>'title'), '') = ''
     or coalesce(trim(p_task->>'category'), '') = ''
     or coalesce(trim(p_task->>'condition'), '') = ''
     or coalesce(trim(p_task->>'answer'), '') = '' then
    raise exception 'required_fields_missing';
  end if;
  if coalesce(p_task->>'difficulty', 'Лёгкая') not in ('Лёгкая', 'Средняя', 'Сложная') then
    raise exception 'invalid_difficulty';
  end if;

  v_hints := coalesce(p_task->'hints', '[]'::jsonb);
  if jsonb_typeof(v_hints) <> 'array' then
    raise exception 'invalid_hints';
  end if;
  v_tolerance := greatest(coalesce(nullif(p_task->>'tolerance', '')::numeric, 0), 0);
  v_id := coalesce(nullif(p_task->>'id', ''), gen_random_uuid()::text);

  insert into public.tasks (
    id, title, category, difficulty, condition, hints, answer,
    tolerance, explanation, published, updated_at
  ) values (
    v_id,
    trim(p_task->>'title'),
    trim(p_task->>'category'),
    coalesce(p_task->>'difficulty', 'Лёгкая'),
    trim(p_task->>'condition'),
    v_hints,
    trim(p_task->>'answer'),
    v_tolerance,
    coalesce(p_task->>'explanation', ''),
    coalesce((p_task->>'published')::boolean, false),
    now()
  )
  on conflict (id) do update set
    title = excluded.title,
    category = excluded.category,
    difficulty = excluded.difficulty,
    condition = excluded.condition,
    hints = excluded.hints,
    answer = excluded.answer,
    tolerance = excluded.tolerance,
    explanation = excluded.explanation,
    published = excluded.published,
    updated_at = now();

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

create or replace function public.admin_delete_task(p_task_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_math_task_teacher() then
    raise exception 'not_authorized';
  end if;
  delete from public.tasks where id = p_task_id;
  return jsonb_build_object('ok', true);
end;
$$;

-- Явно ограничиваем выполнение RPC-функций.
revoke all on function public.list_published_tasks() from public;
revoke all on function public.check_task_answer(text, text) from public;
revoke all on function public.admin_list_tasks() from public;
revoke all on function public.admin_save_task(jsonb) from public;
revoke all on function public.admin_delete_task(text) from public;

grant execute on function public.list_published_tasks() to anon, authenticated;
grant execute on function public.check_task_answer(text, text) to anon, authenticated;
grant execute on function public.admin_list_tasks() to authenticated;
grant execute on function public.admin_save_task(jsonb) to authenticated;
grant execute on function public.admin_delete_task(text) to authenticated;

-- Небольшой набор примеров для проверки после установки.
insert into public.tasks (
  id, title, category, difficulty, condition, hints, answer,
  tolerance, explanation, published
) values
(
  'sample-1', 'Покупка строительных материалов', 'Практика', 'Лёгкая',
  'В магазине купили 4 мешка цемента по 350 рублей за каждый. Сколько рублей заплатили за все мешки?',
  jsonb_build_array('Чтобы узнать общую стоимость, умножь цену одного мешка на количество мешков.', 'Выполни умножение 350 × 4.'),
  '1400', 0, E'350 × 4 = 1400 рублей.\nОтвет: 1400 рублей.', true
),
(
  'sample-2', 'Плитка для пола', 'Строительство', 'Средняя',
  'Для пола одной комнаты нужно 24 плитки. Сколько плиток понадобится для трёх одинаковых комнат?',
  jsonb_build_array('Количество плиток в одной комнате нужно умножить на количество комнат.', 'Вычисли 24 × 3.'),
  '72', 0, E'24 × 3 = 72 плитки.\nОтвет: 72 плитки.', true
),
(
  'sample-3', 'Длина ограждения', 'Практика', 'Лёгкая',
  'Прямоугольный участок имеет длину 12 метров и ширину 8 метров. Сколько метров ограждения понадобится, чтобы огородить участок по всему периметру?',
  jsonb_build_array('Периметр прямоугольника — это сумма длин всех его сторон.', 'Можно сложить длину и ширину и умножить сумму на 2.'),
  '40', 0, E'P = (12 + 8) × 2 = 40 метров.\nОтвет: 40 метров.', true
)
on conflict (id) do nothing;

-- После публикации сайта настройте Supabase Authentication -> URL Configuration:
-- Site URL: полный адрес сайта GitHub Pages.
-- Redirect URLs: тот же адрес, например https://koannko.github.io/math-task-studio/.
-- В Authentication -> Providers -> Email включите Email OTP / Magic Link.
