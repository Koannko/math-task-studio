/* Math Task Studio — Supabase-backed edition.
   Correct answers are never downloaded to the student browser. */

const STORAGE_KEY = "task-studio-progress-v2";

const supabaseClient = window.supabase.createClient(
  window.MATH_TASK_SUPABASE_URL,
  window.MATH_TASK_SUPABASE_KEY
);

const TEACHER_EMAIL = window.MATH_TASK_TEACHER_EMAIL.toLowerCase();

let tasks = [];
let progress = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
let currentView = "student";
let selectedTask = null;
let hintCount = 0;
let editingId = null;
let session = null;
let teacherTasks = [];
let teacherRefreshTimer = null;

const $ = id => document.getElementById(id);

const esc = (s = "") =>
  String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));

const difficultyClass = d =>
  d === "Лёгкая" ? "easy" :
  d === "Средняя" ? "medium" : "hard";

const saveProgress = () =>
  localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));

function notice(message, type = "info") {
  return `<div class="notice ${type}">${esc(message)}</div>`;
}

function setBusy(button, busy, label) {
  if (!button) return;

  button.disabled = busy;

  if (busy) {
    button.dataset.oldText = button.textContent;
    button.textContent = label || "Подождите…";
  } else if (button.dataset.oldText) {
    button.textContent = button.dataset.oldText;
    delete button.dataset.oldText;
  }
}

// Загрузка опубликованных задач и статусов из Supabase
async function loadPublicTasks() {
  const { data, error } =
    await supabaseClient.rpc("list_published_tasks");

  if (error) throw error;

  tasks = Array.isArray(data) ? data : (data || []);

  // Supabase — основной источник информации о решённых задачах.
  tasks.forEach(t => {
    progress[t.id] = {
      ...(progress[t.id] || {}),
      solved: !!t.solved
    };
  });

  saveProgress();
}

// Загрузка задач для учителя
async function loadTeacherTasks() {
  const { data, error } =
    await supabaseClient.rpc("admin_list_tasks");

  if (error) throw error;

  teacherTasks = Array.isArray(data) ? data : (data || []);
}

function isTeacher() {
  return !!session?.user?.email &&
    session.user.email.toLowerCase() === TEACHER_EMAIL;
}

// Основная отрисовка приложения
function render() {
  if (currentView !== "teacher" && teacherRefreshTimer) {
    clearInterval(teacherRefreshTimer);
    teacherRefreshTimer = null;
  }

  document.querySelectorAll(".nav-link").forEach(b => {
    b.classList.toggle("active", b.dataset.view === currentView);
  });

  if (currentView === "teacher") {
    renderTeacher();
  } else if (selectedTask) {
    renderTask();
  } else {
    renderCatalog();
  }
}

// Каталог задач ученика
function renderCatalog() {
  const categories = [
    "Все темы",
    ...new Set(tasks.map(t => t.category).filter(Boolean))
  ];

  const solvedCount =
    tasks.filter(t => !!t.solved).length;

  const startedCount =
    tasks.filter(t => (progress[t.id]?.attempts || 0) > 0).length;

  $("app").innerHTML = `
    <div class="hero">
      <div>
        <div class="eyebrow">Пространство для практики</div>
        <h1>Выбери задачу</h1>
        <div class="muted">
          Решай в своём темпе. Подсказки можно открывать постепенно.
        </div>
      </div>
    </div>

    <div class="stats">
      <div class="stat">
        <strong>${tasks.length}</strong>
        <span>доступно задач</span>
      </div>

      <div class="stat">
        <strong>${solvedCount}</strong>
        <span>решено правильно</span>
      </div>

      <div class="stat">
        <strong>${startedCount}</strong>
        <span>начато задач</span>
      </div>
    </div>

    <div class="toolbar">
      <input
        id="search"
        class="input"
        placeholder="Найти задачу…"
        aria-label="Поиск"
      >

      <select id="category" class="select">
        ${categories.map(c => `<option>${esc(c)}</option>`).join("")}
      </select>

      <select id="level" class="select">
        <option>Любая сложность</option>
        <option>Лёгкая</option>
        <option>Средняя</option>
        <option>Сложная</option>
      </select>
    </div>

    <div id="taskGrid" class="grid"></div>
  `;

  const update = () => {
    const q = $("search").value.toLowerCase();
    const cat = $("category").value;
    const lev = $("level").value;

    const filtered = tasks.filter(t =>
      (t.title + " " + t.condition).toLowerCase().includes(q) &&
      (cat === "Все темы" || t.category === cat) &&
      (lev === "Любая сложность" || t.difficulty === lev)
    );

    // Сначала новые задачи, затем решённые.
    const ordered = [...filtered].sort(
      (a, b) => Number(!!a.solved) - Number(!!b.solved)
    );

    $("taskGrid").innerHTML = ordered.length
      ? ordered.map(t => `
        <article class="task-card">
          <div class="chips">
            <span class="chip ${difficultyClass(t.difficulty)}">
              ${esc(t.difficulty)}
            </span>
            <span class="chip">${esc(t.category)}</span>
          </div>

          <h3>${esc(t.title)}</h3>
          <p>${esc(t.condition)}</p>

          <div class="card-bottom">
            <span class="muted" style="font-size:12px">
              ${t.solved ? "✓ Решена" : "Новая задача"}
            </span>

            <button class="button" data-open="${esc(t.id)}">
              ${t.solved ? "Повторить" : "Решать"}
            </button>
          </div>
        </article>
      `).join("")
      : `<div class="empty">
          Ничего не найдено. Попробуй изменить фильтры.
        </div>`;

    document.querySelectorAll("[data-open]").forEach(b => {
      b.onclick = () => {
        selectedTask = b.dataset.open;
        hintCount = 0;
        render();
      };
    });
  };

  ["search", "category", "level"].forEach(id => {
    $(id).addEventListener(
      id === "search" ? "input" : "change",
      update
    );
  });

  update();
}

// Страница отдельной задачи
function renderTask() {
  const t = tasks.find(x => x.id === selectedTask);

  if (!t) {
    selectedTask = null;
    renderCatalog();
    return;
  }

  const p = {
    ...(progress[t.id] || { attempts: 0, solved: false }),
    solved: !!t.solved
  };

  $("app").innerHTML = `
    <button class="button ghost back" id="back">
      ← Ко всем задачам
    </button>

    <article class="detail-card">
      <div class="chips">
        <span class="chip ${difficultyClass(t.difficulty)}">
          ${esc(t.difficulty)}
        </span>
        <span class="chip">${esc(t.category)}</span>
      </div>

      <h1>${esc(t.title)}</h1>

      <div class="condition">${esc(t.condition)}</div>

      <div class="section">
        <h3>Подсказки</h3>
        <p class="muted">
          Открывай их по одной, если понадобится помощь.
        </p>

        <div id="hints">
          ${(t.hints || []).slice(0, hintCount).map((h, i) => `
            <div class="hint">
              <strong>Подсказка ${i + 1}</strong>
              <div>${esc(h)}</div>
            </div>
          `).join("")}
        </div>

        <button
          class="button secondary"
          id="showHint"
          ${hintCount >= (t.hints || []).length ? "disabled" : ""}
        >
          ${hintCount >= (t.hints || []).length
            ? "Все подсказки открыты"
            : "Показать подсказку"}
        </button>
      </div>

      <div class="section">
        <h3>Твой ответ</h3>

        <form id="answerForm">
          <div class="answer-row">
            <input
              id="answerInput"
              class="input"
              autocomplete="off"
              placeholder="Введи ответ"
              required
            >

            <button class="button" id="checkButton">
              Проверить
            </button>
          </div>
        </form>

        <div id="feedback"></div>
      </div>

      <div class="section">
        <h3>Разбор решения</h3>

        <p class="muted">
          Сначала попробуй решить самостоятельно.
          После правильной проверки здесь можно посмотреть объяснение.
        </p>

        <button
          class="button ghost"
          id="showExplanation"
          ${p.solved ? "" : "disabled"}
        >
          Показать объяснение
        </button>

        <div
          id="explanation"
          class="explanation ${p.solved ? "" : "hidden"}"
        >
          ${p.solved
            ? esc(t.explanation || "Объяснение пока не добавлено.")
            : ""}
        </div>
      </div>
    </article>
  `;

  $("back").onclick = () => {
    selectedTask = null;
    renderCatalog();
  };

  $("showHint").onclick = () => {
    hintCount++;
    renderTask();
  };

  // Проверка ответа
  $("answerForm").onsubmit = async e => {
    e.preventDefault();

    const button = $("checkButton");
    setBusy(button, true, "Проверяем…");

    try {
      const { data, error } = await supabaseClient.rpc(
        "check_task_answer",
        {
          p_task_id: t.id,
          p_submitted_answer: $("answerInput").value.trim()
        }
      );

      if (error) throw error;

      const result =
        typeof data === "string" ? JSON.parse(data) : data;

      const old = progress[t.id] || {
        attempts: 0,
        solved: false
      };

      old.attempts++;
      old.lastAttempt = new Date().toISOString();

      if (result?.correct) {
        old.solved = true;
        old.solvedAt = new Date().toISOString();

        // Обновляем статус задачи в текущем каталоге.
        t.solved = true;
      }

      progress[t.id] = old;
      saveProgress();

      const f = $("feedback");

      f.className = "feedback " +
        (result?.correct ? "good" : "bad");

      f.textContent = result?.correct
        ? "Верно! Отличная работа. Теперь можешь посмотреть разбор решения."
        : "Пока неверно. Попробуй ещё раз или воспользуйся подсказками.";

      $("showExplanation").disabled = !result?.correct;

      if (result?.correct) {
        $("explanation").textContent =
          result.explanation ||
          t.explanation ||
          "Объяснение пока не добавлено.";

        $("explanation").classList.add("hidden");
      }

    } catch (err) {
      $("feedback").className = "feedback bad";
      $("feedback").textContent =
        "Не удалось проверить ответ. Проверь подключение и попробуй ещё раз.";

      console.error(err);

    } finally {
      setBusy(button, false);
    }
  };

  $("showExplanation").onclick = () =>
    $("explanation").classList.remove("hidden");
}

// Панель учителя
function renderTeacher() {
  if (!isTeacher()) {
    renderTeacherLogin();
    return;
  }

  $("app").innerHTML = `
    <div class="hero">
      <div>
        <div class="eyebrow">Управление материалами</div>
        <h1>Панель учителя</h1>
        <div class="muted">
          Общая база задач Supabase. Изменения сразу доступны ученикам.
        </div>
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="button secondary" id="refreshStatuses">
          Обновить статусы
        </button>

        <button class="button" id="newTask">
          + Новая задача
        </button>

        <button class="button ghost" id="signOut">
          Выйти
        </button>
      </div>
    </div>

    <div class="muted" style="margin-bottom:16px">
      Вход выполнен: ${esc(session.user.email)}
    </div>

    <div class="toolbar">
      <input
        class="input"
        id="adminSearch"
        placeholder="Поиск по задачам…"
      >
    </div>

    <div id="adminList" class="admin-list"></div>
  `;

  $("refreshStatuses").onclick = refreshTeacher;

  $("newTask").onclick = () => {
    editingId = null;
    renderEditor();
  };

  $("signOut").onclick = async () => {
    await supabaseClient.auth.signOut();
    session = null;
    currentView = "student";
    render();
  };

  $("adminSearch").oninput = renderAdminList;

  renderAdminList();

  // Автоматическое обновление статусов каждые 15 секунд.
  if (teacherRefreshTimer) {
    clearInterval(teacherRefreshTimer);
  }

  teacherRefreshTimer = setInterval(async () => {
    if (
      currentView !== "teacher" ||
      !isTeacher() ||
      !$("adminList")
    ) {
      return;
    }

    try {
      await loadTeacherTasks();

      if ($("adminList")) {
        renderAdminList();
      }
    } catch (err) {
      console.error("Не удалось обновить статусы задач:", err);
    }
  }, 15000);
}

// Форма входа учителя
function renderTeacherLogin(message = "") {
  $("app").innerHTML = `
    <div class="form-card">
      <div class="eyebrow">Закрытый доступ</div>
      <h1>Вход учителя</h1>

      <p class="muted">
        На ${esc(TEACHER_EMAIL)} придёт одноразовая ссылка для входа.
        Ученикам вход не нужен.
      </p>

      ${message ? notice(message) : ""}

      <form id="loginForm">
        <div class="field">
          <label for="teacherEmail">Email учителя</label>
          <input
            class="input"
            id="teacherEmail"
            type="email"
            value="${esc(TEACHER_EMAIL)}"
            readonly
          >
        </div>

        <button class="button" id="sendLink">
          Отправить ссылку для входа
        </button>
      </form>
    </div>
  `;

  $("loginForm").onsubmit = async e => {
    e.preventDefault();

    const b = $("sendLink");
    setBusy(b, true, "Отправляем…");

    try {
      const { error } = await supabaseClient.auth.signInWithOtp({
        email: TEACHER_EMAIL,
        options: {
          emailRedirectTo: location.href.split("#")[0]
        }
      });

      if (error) throw error;

      renderTeacherLogin(
        "Ссылка отправлена. Открой письмо и перейди по ссылке на этом устройстве."
      );

    } catch (err) {
      console.error(err);

      renderTeacherLogin(
        "Не удалось отправить письмо. Проверь настройки Email в Supabase и Redirect URLs."
      );

    } finally {
      setBusy($("sendLink"), false);
    }
  };
}

// Список задач в панели учителя
function renderAdminList() {
  const q = $("adminSearch")?.value.toLowerCase() || "";

  const list = teacherTasks.filter(t =>
    (t.title + " " + t.category).toLowerCase().includes(q)
  );

  $("adminList").innerHTML = list.length
    ? list.map(t => `
      <div class="admin-row">
        <div>
          <strong>${esc(t.title)}</strong>

          <span class="muted" style="font-size:12px">
            ${esc(t.category)} ·
            ${esc(t.difficulty)} ·
            ${t.published ? "Опубликована" : "Черновик"} ·

            <span class="chip ${t.solved ? "easy" : "medium"}">
              ${t.solved ? "Решил" : "Не решил"}
            </span>
          </span>
        </div>

        <div class="admin-actions">
          <button class="small-button" data-edit="${esc(t.id)}">
            Изменить
          </button>

          <button class="small-button" data-toggle="${esc(t.id)}">
            ${t.published ? "Скрыть" : "Опубликовать"}
          </button>

          <button class="small-button red" data-delete="${esc(t.id)}">
            Удалить
          </button>
        </div>
      </div>
    `).join("")
    : `<div class="empty">Задач пока нет.</div>`;

  document.querySelectorAll("[data-edit]").forEach(b => {
    b.onclick = () => {
      editingId = b.dataset.edit;
      renderEditor();
    };
  });

  document.querySelectorAll("[data-toggle]").forEach(b => {
    b.onclick = async () => {
      const t = teacherTasks.find(x => x.id === b.dataset.toggle);

      await saveTask({
        ...t,
        published: !t.published
      });
    };
  });

  document.querySelectorAll("[data-delete]").forEach(b => {
    b.onclick = async () => {
      if (confirm("Удалить эту задачу?")) {
        const { error } = await supabaseClient.rpc(
          "admin_delete_task",
          { p_task_id: b.dataset.delete }
        );

        if (error) {
          alert("Не удалось удалить задачу.");
          console.error(error);
        } else {
          await refreshTeacher();
        }
      }
    };
  });
}

// Обновление данных учителя и ученика
async function refreshTeacher() {
  try {
    await Promise.all([
      loadTeacherTasks(),
      loadPublicTasks()
    ]);

    renderTeacher();

  } catch (e) {
    console.error(e);

    $("app").insertAdjacentHTML(
      "afterbegin",
      notice(
        "Не удалось загрузить задачи. Проверьте SQL-настройку Supabase."
      )
    );
  }
}

// Сохранение задачи
async function saveTask(item) {
  const { error } = await supabaseClient.rpc(
    "admin_save_task",
    { p_task: item }
  );

  if (error) {
    alert("Не удалось сохранить задачу. Проверьте подключение и права доступа.");
    console.error(error);
    return;
  }

  await refreshTeacher();
}

// Редактор задачи
function renderEditor() {
  if (teacherRefreshTimer) {
    clearInterval(teacherRefreshTimer);
    teacherRefreshTimer = null;
  }

  const t = teacherTasks.find(x => x.id === editingId) || {
    title: "",
    category: "",
    difficulty: "Лёгкая",
    condition: "",
    hints: [""],
    answer: "",
    tolerance: 0,
    explanation: "",
    published: false
  };

  $("app").innerHTML = `
    <button class="button ghost back" id="cancel">
      ← К списку задач
    </button>

    <div class="form-card">
      <div class="eyebrow">
        ${editingId ? "Редактирование" : "Создание"}
      </div>

      <h1>${editingId ? "Изменить задачу" : "Новая задача"}</h1>

      <form id="taskForm">
        <div class="field">
          <label for="title">Название</label>
          <input
            class="input"
            id="title"
            required
            value="${esc(t.title)}"
          >
        </div>

        <div class="field">
          <label for="category">Категория</label>
          <input
            class="input"
            id="category"
            required
            value="${esc(t.category)}"
            placeholder="Например, Строительство"
          >
        </div>

        <div class="field">
          <label for="difficulty">Сложность</label>
          <select class="select" id="difficulty">
            ${["Лёгкая", "Средняя", "Сложная"].map(x => `
              <option ${t.difficulty === x ? "selected" : ""}>
                ${x}
              </option>
            `).join("")}
          </select>
        </div>

        <div class="field">
          <label for="condition">Условие задачи</label>
          <textarea class="textarea" id="condition" required>${esc(t.condition)}</textarea>
        </div>

        <div class="field">
          <label>Подсказки</label>

          <div id="hintFields">
            ${(t.hints || []).map((h, i) => `
              <div class="hint-editor">
                <input
                  class="input hint-value"
                  value="${esc(h)}"
                  placeholder="Подсказка ${i + 1}"
                >

                <button
                  type="button"
                  class="small-button red remove-hint"
                >×</button>
              </div>
            `).join("")}
          </div>

          <button type="button" class="button ghost" id="addHint">
            + Добавить подсказку
          </button>
        </div>

        <div class="field">
          <label for="answer">
            Правильный ответ (хранится только на сервере)
          </label>

          <input
            class="input"
            id="answer"
            required
            value="${esc(t.answer)}"
          >
        </div>

        <div class="field">
          <label for="tolerance">Допустимая погрешность</label>

          <input
            class="input"
            id="tolerance"
            type="number"
            min="0"
            step="any"
            value="${Number(t.tolerance || 0)}"
          >
        </div>

        <div class="field">
          <label for="explanation">Объяснение решения</label>
          <textarea class="textarea" id="explanation">${esc(t.explanation)}</textarea>
        </div>

        <label>
          <input
            type="checkbox"
            id="published"
            ${t.published ? "checked" : ""}
          >
          Опубликовать для учеников
        </label>

        <div class="form-actions">
          <button class="button" id="saveTaskButton">
            Сохранить задачу
          </button>

          <button type="button" class="button ghost" id="cancel2">
            Отмена
          </button>
        </div>
      </form>
    </div>
  `;

  const cancel = () => renderTeacher();

  $("cancel").onclick = cancel;
  $("cancel2").onclick = cancel;

  function wireRemove() {
    document.querySelectorAll(".remove-hint").forEach(b => {
      b.onclick = () => b.parentElement.remove();
    });
  }

  wireRemove();

  $("addHint").onclick = () => {
    const wrap = document.createElement("div");

    wrap.className = "hint-editor";

    wrap.innerHTML = `
      <input
        class="input hint-value"
        placeholder="Новая подсказка"
      >

      <button
        type="button"
        class="small-button red remove-hint"
      >×</button>
    `;

    $("hintFields").append(wrap);
    wireRemove();
  };

  $("taskForm").onsubmit = async e => {
    e.preventDefault();

    const item = {
      id: editingId || crypto.randomUUID(),
      title: $("title").value.trim(),
      category: $("category").value.trim(),
      difficulty: $("difficulty").value,
      condition: $("condition").value.trim(),

      hints: [...document.querySelectorAll(".hint-value")]
        .map(x => x.value.trim())
        .filter(Boolean),

      answer: $("answer").value.trim(),
      tolerance: Number($("tolerance").value || 0),
      explanation: $("explanation").value.trim(),
      published: $("published").checked
    };

    setBusy(
      $("saveTaskButton"),
      true,
      "Сохраняем…"
    );

    await saveTask(item);
  };
}

// Запуск приложения
async function init() {
  const {
    data: { session: activeSession }
  } = await supabaseClient.auth.getSession();

  session = activeSession;

  // Восстановление сессии после перехода по Magic Link.
  supabaseClient.auth.onAuthStateChange((_event, newSession) => {
    session = newSession;
  });

  try {
    await loadPublicTasks();
  } catch (e) {
    console.error(e);

    $("app").innerHTML = notice(
      "Не удалось подключиться к Supabase. Сначала выполните SQL-код, затем обновите страницу.",
      "error"
    );

    return;
  }

  document.querySelectorAll(".nav-link").forEach(b => {
    b.addEventListener("click", async () => {
      currentView = b.dataset.view;
      selectedTask = null;

      if (currentView === "teacher" && isTeacher()) {
        await refreshTeacher();
      } else {
        render();
      }
    });
  });

  $("homeLink").onclick = e => {
    e.preventDefault();
    currentView = "student";
    selectedTask = null;
    render();
  };

  render();
}

init();
