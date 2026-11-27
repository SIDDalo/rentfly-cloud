import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const API_BASE = "https://rentfly-api.onrender.com/api";

const apiStatusEl = document.getElementById("api-status");
const sesionInfoEl = document.getElementById("sesion-info");
const btnLogoutEl = document.getElementById("btn-logout");

const loginSectionEl = document.getElementById("login-section");
const loginFormEl = document.getElementById("login-form");
const loginFeedbackEl = document.getElementById("login-feedback");
const appContentEl = document.getElementById("app-content");

const aeronavesListEl = document.getElementById("aeronaves-list");
const usuarioSelectEl = document.getElementById("usuario_id");
const aeronaveSelectEl = document.getElementById("aeronave_id");
const reservaFormEl = document.getElementById("reserva-form");
const formFeedbackEl = document.getElementById("form-feedback");
const reservasListEl = document.getElementById("reservas-list");
const notificacionesListEl = document.getElementById("notificaciones-list");
const btnRefreshEl = document.getElementById("btn-refresh");

const editarSectionEl = document.getElementById("editar-section");
const editarFormEl = document.getElementById("editar-reserva-form");
const editFeedbackEl = document.getElementById("edit-feedback");
const btnCancelarEdicionEl = document.getElementById("btn-cancelar-edicion");

let sbAuth = null;
let accessToken = null;
let perfilActual = null;
let aeronavesCache = [];
let reservasCache = [];

function esStaff() {
  return ["admin", "empleado", "administrador"].includes(
    (perfilActual?.rol || "").toLowerCase()
  );
}

async function apiFetch(ruta, opciones = {}) {
  const headers = {
    ...(opciones.headers || {}),
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };
  return fetch(`${API_BASE}${ruta}`, { ...opciones, headers });
}

async function checkHealth() {
  try {
    const res = await fetch(`${API_BASE}/health`);
    if (!res.ok) throw new Error("Respuesta no OK");
    apiStatusEl.textContent = "API en línea";
    apiStatusEl.className = "badge ok";
  } catch {
    apiStatusEl.textContent = "API sin conexión";
    apiStatusEl.className = "badge err";
  }
}

function mostrarApp(perfil) {
  perfilActual = perfil;
  loginSectionEl.style.display = "none";
  appContentEl.style.display = "block";
  sesionInfoEl.style.display = "inline-block";
  sesionInfoEl.textContent = `${perfil.nombre_completo} (${perfil.rol})`;
  btnLogoutEl.style.display = "inline-block";
}

function mostrarLogin() {
  perfilActual = null;
  accessToken = null;
  appContentEl.style.display = "none";
  editarSectionEl.style.display = "none";
  loginSectionEl.style.display = "block";
  sesionInfoEl.style.display = "none";
  btnLogoutEl.style.display = "none";
}

async function loadCatalogos() {
  const [resAero, resUsers] = await Promise.all([
    apiFetch("/aeronaves"),
    apiFetch("/usuarios"),
  ]);

  const aeronaves = await resAero.json();
  const usuarios = await resUsers.json();
  aeronavesCache = Array.isArray(aeronaves) ? aeronaves : [];

  aeronavesListEl.innerHTML = aeronavesCache
    .map(
      (a) => `
      <div class="item-box">
        <strong>${a.matricula_aeronave}</strong> — ${a.modelo}
        <div>Estado: <b>${a.estado_operativo}</b></div>
        <div>Tarifa: $${a.tarifa_hora} / h · Célula: ${a.horas_celula_totales} h</div>
      </div>
    `
    )
    .join("");

  const opcionesAeronaves = aeronavesCache
    .map(
      (a) =>
        `<option value="${a.aeronave_id}">${a.matricula_aeronave} (${a.modelo} - ${a.estado_operativo})</option>`
    )
    .join("");

  aeronaveSelectEl.innerHTML = opcionesAeronaves;
  document.getElementById("edit_aeronave_id").innerHTML = opcionesAeronaves;

  const listaUsuarios = Array.isArray(usuarios) ? usuarios : [];
  const opcionesUsuarios = listaUsuarios
    .map(
      (u) =>
        `<option value="${u.usuario_id}">${u.nombre_completo} (${u.rol} · ${u.saldo_horas} h)</option>`
    )
    .join("");

  usuarioSelectEl.innerHTML = opcionesUsuarios;
  if (!esStaff() && perfilActual?.usuario_id) {
    usuarioSelectEl.value = perfilActual.usuario_id;
    usuarioSelectEl.disabled = true;
  } else {
    usuarioSelectEl.disabled = false;
  }
  document.getElementById("edit_usuario_id").innerHTML = opcionesUsuarios;
}

async function loadReservasYAlertas() {
  const res = await apiFetch("/reservas/detalle");
  const data = await res.json();

  const reservas = Array.isArray(data.reservas) ? data.reservas : [];
  reservasCache = reservas;
  const staff = esStaff();

  reservasListEl.innerHTML = reservas.length
    ? reservas
        .map((r) => {
          const piloto = r.usuarios?.nombre_completo || r.usuario_id;
          const nave = r.aeronaves
            ? `${r.aeronaves.matricula_aeronave} (${r.aeronaves.modelo})`
            : r.aeronave_id;
          const checklist = r.bitacora_nosql?.checklist_prevuelo;

          return `
            <div class="reserva-card">
              <div>
                <strong>${nave}</strong> — Estatus: <b>${r.estatus}</b>
                <div>Piloto/Alumno: ${piloto} · Tipo: ${r.tipo_vuelo} · Estimadas: ${r.horas_estimadas} h</div>
                <div>Checklist NoSQL: aceite_ok=${checklist?.aceite_ok ?? "N/A"}, combustible=${checklist?.combustible_galones ?? "N/A"} gal</div>
              </div>
              <div>
                <button class="btn-secondary" onclick="abrirEditarReserva('${r.reserva_id}')">Editar</button>
                ${
                  staff && r.estatus !== "completada"
                    ? `<button class="btn-complete" onclick="completarReserva('${r.reserva_id}')">Completar vuelo</button>`
                    : ""
                }
                ${
                  staff
                    ? `<button class="btn-danger" onclick="eliminarReserva('${r.reserva_id}')">Eliminar</button>`
                    : ""
                }
              </div>
            </div>
          `;
        })
        .join("")
    : "<p>No hay reservas registradas aún.</p>";

  const alertas = Array.isArray(data.notificaciones) ? data.notificaciones : [];
  notificacionesListEl.innerHTML = alertas.length
    ? alertas
        .map(
          (n) =>
            `<li><b>[${n.tipo}]</b> ${n.mensaje} <small>(reserva_id: ${n.reserva_id})</small></li>`
        )
        .join("")
    : "<li>Sin notificaciones registradas.</li>";
}

loginFormEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginFeedbackEl.textContent = "Verificando credenciales...";

  try {
    if (!sbAuth) {
      const cfgRes = await fetch(`${API_BASE}/public-config`);
      const cfg = await cfgRes.json();
      if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
        loginFeedbackEl.textContent = "Error: faltan SUPABASE_URL o SUPABASE_ANON_KEY en /api/public-config.";
        return;
      }
      sbAuth = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    }

    const correo = document.getElementById("login_correo").value.trim();
    const password = document.getElementById("login_password").value;

    const { data, error } = await sbAuth.auth.signInWithPassword({ email: correo, password });
    if (error || !data?.session) {
      loginFeedbackEl.textContent = `Error de inicio de sesión: ${error?.message || "Credenciales inválidas"}`;
      return;
    }

    accessToken = data.session.access_token;
    const resMe = await apiFetch("/me");
    const meData = await resMe.json();

    if (!resMe.ok || !meData.perfil) {
      loginFeedbackEl.textContent = `Error de perfil/RLS: ${meData.error || "No autorizado"}`;
      return;
    }

    loginFeedbackEl.textContent = "";
    mostrarApp(meData.perfil);
    await Promise.all([loadCatalogos(), loadReservasYAlertas()]);
  } catch (err) {
    console.error("Error en login:", err);
    loginFeedbackEl.textContent = `Error inesperado al iniciar sesión: ${err.message}`;
  }
});

btnLogoutEl.addEventListener("click", async () => {
  if (sbAuth) await sbAuth.auth.signOut();
  mostrarLogin();
});

reservaFormEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  formFeedbackEl.textContent = "Guardando reserva en SQL (RLS) y NoSQL...";

  const avionSeleccionado = aeronavesCache.find(
    (a) => a.aeronave_id === aeronaveSelectEl.value
  );

  const payload = {
    usuario_id: usuarioSelectEl.value,
    aeronave_id: aeronaveSelectEl.value,
    modelo_aeronave: avionSeleccionado?.modelo || "Aeronave",
    fecha_inicio: new Date(document.getElementById("fecha_inicio").value).toISOString(),
    fecha_fin: new Date(document.getElementById("fecha_fin").value).toISOString(),
    tipo_vuelo: document.getElementById("tipo_vuelo").value.trim().toLowerCase(),
    horas_estimadas: Number(document.getElementById("horas_estimadas").value),
  };

  const res = await apiFetch("/reservas", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const result = await res.json();
  if (!res.ok) {
    formFeedbackEl.textContent = `Error: ${result.error || "No se pudo crear la reserva"}`;
    return;
  }

  formFeedbackEl.textContent = "Reserva creada en Supabase y sincronizada con Firestore.";
  reservaFormEl.reset();
  await Promise.all([loadCatalogos(), loadReservasYAlertas()]);
});

function toDatetimeLocal(isoString) {
  if (!isoString) return "";
  const d = new Date(isoString);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

window.abrirEditarReserva = function (reservaId) {
  const r = reservasCache.find((item) => item.reserva_id === reservaId);
  if (!r) return;

  document.getElementById("edit_reserva_id").value = r.reserva_id;
  document.getElementById("edit_usuario_id").value = r.usuario_id;
  document.getElementById("edit_aeronave_id").value = r.aeronave_id;
  document.getElementById("edit_fecha_inicio").value = toDatetimeLocal(r.fecha_inicio);
  document.getElementById("edit_fecha_fin").value = toDatetimeLocal(r.fecha_fin);
  document.getElementById("edit_tipo_vuelo").value = r.tipo_vuelo;
  document.getElementById("edit_horas_estimadas").value = r.horas_estimadas;
  document.getElementById("edit_estatus").value = r.estatus || "confirmada";
  editFeedbackEl.textContent = "";

  editarSectionEl.style.display = "block";
  editarSectionEl.scrollIntoView({ behavior: "smooth" });
};

btnCancelarEdicionEl.addEventListener("click", () => {
  editarSectionEl.style.display = "none";
});

editarFormEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  editFeedbackEl.textContent = "Guardando cambios en SQL (RLS) y NoSQL...";

  const reservaId = document.getElementById("edit_reserva_id").value;
  const aeronaveId = document.getElementById("edit_aeronave_id").value;
  const avionSel = aeronavesCache.find((a) => a.aeronave_id === aeronaveId);

  const payload = {
    usuario_id: document.getElementById("edit_usuario_id").value,
    aeronave_id: aeronaveId,
    modelo_aeronave: avionSel?.modelo || "Aeronave asignada",
    fecha_inicio: new Date(document.getElementById("edit_fecha_inicio").value).toISOString(),
    fecha_fin: new Date(document.getElementById("edit_fecha_fin").value).toISOString(),
    tipo_vuelo: document.getElementById("edit_tipo_vuelo").value.trim().toLowerCase(),
    horas_estimadas: Number(document.getElementById("edit_horas_estimadas").value),
    estatus: document.getElementById("edit_estatus").value,
  };

  const res = await apiFetch(`/reservas/${reservaId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const result = await res.json();
  if (!res.ok) {
    editFeedbackEl.textContent = `Error: ${result.error || "No se pudo actualizar la reserva"}`;
    return;
  }

  editFeedbackEl.textContent = "Reserva actualizada correctamente.";
  editarSectionEl.style.display = "none";
  await Promise.all([loadCatalogos(), loadReservasYAlertas()]);
});

window.completarReserva = async function (reservaId) {
  const res = await apiFetch(`/reservas/${reservaId}/completar`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      novedades_mecanicas: "Sin novedades",
      observaciones_instructor: "Vuelo completado desde interfaz RentFly",
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || "No autorizado para completar vuelo.");
    return;
  }
  await Promise.all([loadCatalogos(), loadReservasYAlertas()]);
};

window.eliminarReserva = async function (reservaId) {
  const res = await apiFetch(`/reservas/${reservaId}`, {
    method: "DELETE",
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || "No autorizado para eliminar reserva.");
    return;
  }
  await Promise.all([loadCatalogos(), loadReservasYAlertas()]);
};

btnRefreshEl.addEventListener("click", async () => {
  await Promise.all([loadCatalogos(), loadReservasYAlertas()]);
});

async function init() {
  await checkHealth();
  try {
    const cfgRes = await fetch(`${API_BASE}/public-config`);
    const cfg = await cfgRes.json();
    if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
      loginFeedbackEl.textContent = "Configuración de Supabase incompleta en /api/public-config.";
      mostrarLogin();
      return;
    }
    sbAuth = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

    const { data: sessionData } = await sbAuth.auth.getSession();
    if (sessionData?.session) {
      accessToken = sessionData.session.access_token;
      const resMe = await apiFetch("/me");
      if (resMe.ok) {
        const meData = await resMe.json();
        mostrarApp(meData.perfil);
        await Promise.all([loadCatalogos(), loadReservasYAlertas()]);
        return;
      }
    }
  } catch (err) {
    console.error("Error inicializando auth:", err);
    loginFeedbackEl.textContent = `No se pudo inicializar el login: ${err.message}`;
  }
  mostrarLogin();
}

init();