global.WebSocket = require("ws");
require("dotenv").config();
const { FieldValue } = require("firebase-admin/firestore");
const { createClient } = require("@supabase/supabase-js");
const express = require("express");
const cors = require("cors");
const { supabase, dbFirestore } = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

app.use(cors());
app.use(express.json());

function crearClienteUsuario(token) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    realtime: {
      params: {
        eventsPerSecond: 1,
      },
    },
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });
}

// Middleware de autenticación + resolución de rol desde public.usuarios
async function requerirAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;

    if (!token) {
      return res.status(401).json({ error: "Token de sesión requerido. Inicia sesión primero." });
    }

    const { data: authData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authData?.user) {
      return res.status(401).json({ error: "Sesión inválida o expirada." });
    }

    const sbUser = crearClienteUsuario(token);
    const authUser = authData.user;

    const { data: perfil, error: perfilErr } = await sbUser
      .from("usuarios")
      .select("usuario_id, nombre_completo, correo, rol, saldo_horas, auth_user_id")
      .eq("correo", authUser.email)
      .limit(1)
      .maybeSingle();

    if (perfilErr) {
      return res.status(500).json({ error: `Error consultando perfil: ${perfilErr.message}` });
    }

    if (!perfil) {
      return res.status(403).json({
        error: "Usuario autenticado sin perfil vinculado en public.usuarios.",
      });
    }

    if (!perfil.auth_user_id) {
      await supabase
        .from("usuarios")
        .update({ auth_user_id: authUser.id })
        .eq("usuario_id", perfil.usuario_id);
      perfil.auth_user_id = authUser.id;
    }

    req.usuarioAuth = authUser;
    req.perfil = perfil;
    req.sb = sbUser;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function requerirRol(rolesPermitidos) {
  return (req, res, next) => {
    const rolActual = (req.perfil?.rol || "").toLowerCase();
    const permitidos = rolesPermitidos.map((r) => r.toLowerCase());
    if (!permitidos.includes(rolActual)) {
      return res.status(403).json({
        error: `Acceso denegado para el rol '${req.perfil?.rol}'. Se requiere: ${rolesPermitidos.join(", ")}.`,
      });
    }
    next();
  };
}

// Salud del servicio
app.get("/api/health", (req, res) => {
  res.json({ ok: true, servicio: "RentFly API Hibrida (SQL + NoSQL + RLS)" });
});
//--------------------------------------------------------
app.get("/api/public-config", (req, res) => {
  res.json({
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: SUPABASE_ANON_KEY,
  });
});
//--------------------------------------------------------
// Perfil y rol del usuario autenticado
app.get("/api/me", requerirAuth, (req, res) => {
  res.json({ perfil: req.perfil });
});

// Listar aeronaves desde Supabase (RLS aplicado al token)
app.get("/api/aeronaves", requerirAuth, async (req, res) => {
  const { data, error } = await req.sb
    .from("aeronaves")
    .select("*")
    .order("matricula_aeronave", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Listar usuarios desde Supabase (RLS aplicado al token)
app.get("/api/usuarios", requerirAuth, async (req, res) => {
  const { data, error } = await req.sb
    .from("usuarios")
    .select("usuario_id, nombre_completo, correo, rol, numero_licencia_o_matricula, saldo_horas, activo")
    .order("nombre_completo", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// CREATE HIBRIDO: Crea reserva en Supabase (con RLS) + checklist y notificacion en Firestore
app.post("/api/reservas", requerirAuth, async (req, res) => {
  try {
    const rol = (req.perfil.rol || "").toLowerCase();
    const esStaff = ["admin", "empleado", "administrador"].includes(rol);

    const {
      usuario_id,
      instructor_id,
      aeronave_id,
      fecha_inicio,
      fecha_fin,
      tipo_vuelo,
      horas_estimadas,
      modelo_aeronave = "Aeronave asignada",
    } = req.body;

    const usuarioDestino = esStaff && usuario_id ? usuario_id : req.perfil.usuario_id;

    if (!usuarioDestino || !aeronave_id || !fecha_inicio || !fecha_fin || !tipo_vuelo || !horas_estimadas) {
      return res.status(400).json({ error: "Faltan campos obligatorios de la reserva." });
    }

    const { data: reservaCreada, error: errorSql } = await req.sb
      .from("reservas")
      .insert([
        {
          usuario_id: usuarioDestino,
          instructor_id: instructor_id || null,
          aeronave_id,
          fecha_inicio,
          fecha_fin,
          tipo_vuelo: String(tipo_vuelo).trim().toLowerCase(),
          horas_estimadas,
          estatus: "confirmada",
        },
      ])
      .select()
      .single();

    if (errorSql) {
      return res.status(400).json({ error: errorSql.message });
    }

    const reservaId = reservaCreada.reserva_id;

    await dbFirestore.collection("bitacoras_vuelo_y_checklists").add({
      reserva_id: reservaId,
      usuario_id: usuarioDestino,
      aeronave_id,
      modelo_aeronave,
      checklist_prevuelo: {
        aceite_ok: false,
        combustible_galones: 0,
        avionica_y_luces_ok: false,
      },
      reporte_postvuelo: {
        novedades_mecanicas: "Pendiente",
        observaciones_instructor: "",
      },
      actualizado_en: FieldValue.serverTimestamp(),
    });

    await dbFirestore.collection("notificaciones_y_alertas").add({
      usuario_id: usuarioDestino,
      reserva_id: reservaId,
      tipo: "reserva_confirmada",
      mensaje: `Reserva confirmada por ${req.perfil.nombre_completo} para ${modelo_aeronave} (${tipo_vuelo}, ${horas_estimadas} h).`,
      leida: false,
      creada_en: FieldValue.serverTimestamp(),
    });

    res.status(201).json({
      mensaje: "Reserva creada en SQL (RLS) y sincronizada con NoSQL.",
      reserva: reservaCreada,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// READ HIBRIDO: Lista reservas filtradas por RLS + bitacoras y notificaciones de NoSQL
app.get("/api/reservas/detalle", requerirAuth, async (req, res) => {
  try {
    const { data: reservas, error } = await req.sb
      .from("reservas")
      .select(`
        *,
        usuarios!reservas_usuario_id_fkey (nombre_completo, numero_licencia_o_matricula, saldo_horas),
        aeronaves (matricula_aeronave, modelo, horas_celula_totales)
      `)
      .order("creado_en", { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    const bitacorasSnap = await dbFirestore.collection("bitacoras_vuelo_y_checklists").get();
    const bitacorasPorReserva = {};
    bitacorasSnap.forEach((doc) => {
      const d = doc.data();
      bitacorasPorReserva[d.reserva_id] = { id: doc.id, ...d };
    });

    const notificacionesSnap = await dbFirestore
      .collection("notificaciones_y_alertas")
      .orderBy("creada_en", "desc")
      .limit(20)
      .get();
    const notificaciones = notificacionesSnap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    const combinado = reservas.map((r) => ({
      ...r,
      bitacora_nosql: bitacorasPorReserva[r.reserva_id] || null,
    }));

    res.json({ reservas: combinado, notificaciones });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// UPDATE GENERAL: Modifica datos de la reserva en SQL (RLS) y sincroniza en NoSQL
app.put("/api/reservas/:reservaId", requerirAuth, async (req, res) => {
  try {
    const { reservaId } = req.params;
    const {
      usuario_id,
      instructor_id,
      aeronave_id,
      modelo_aeronave,
      fecha_inicio,
      fecha_fin,
      tipo_vuelo,
      horas_estimadas,
      estatus,
    } = req.body;

    const { data: reservaActual, error: errFind } = await req.sb
      .from("reservas")
      .select("*")
      .eq("reserva_id", reservaId)
      .single();

    if (errFind || !reservaActual) {
      return res.status(404).json({ error: "Reserva no encontrada o sin permiso RLS." });
    }

    const camposActualizar = {};
    if (usuario_id) camposActualizar.usuario_id = usuario_id;
    if (instructor_id !== undefined) camposActualizar.instructor_id = instructor_id || null;
    if (aeronave_id) camposActualizar.aeronave_id = aeronave_id;
    if (fecha_inicio) camposActualizar.fecha_inicio = fecha_inicio;
    if (fecha_fin) camposActualizar.fecha_fin = fecha_fin;
    if (tipo_vuelo) camposActualizar.tipo_vuelo = String(tipo_vuelo).trim().toLowerCase();
    if (horas_estimadas !== undefined) camposActualizar.horas_estimadas = Number(horas_estimadas);
    if (estatus) camposActualizar.estatus = estatus;

    const { data: reservaModificada, error: errUpd } = await req.sb
      .from("reservas")
      .update(camposActualizar)
      .eq("reserva_id", reservaId)
      .select()
      .single();

    if (errUpd) {
      return res.status(400).json({ error: errUpd.message });
    }

    const snap = await dbFirestore
      .collection("bitacoras_vuelo_y_checklists")
      .where("reserva_id", "==", reservaId)
      .get();

    for (const doc of snap.docs) {
      const patchBitacora = { actualizado_en: FieldValue.serverTimestamp() };
      if (camposActualizar.aeronave_id) patchBitacora.aeronave_id = camposActualizar.aeronave_id;
      if (modelo_aeronave) patchBitacora.modelo_aeronave = modelo_aeronave;
      await doc.ref.update(patchBitacora);
    }

    await dbFirestore.collection("notificaciones_y_alertas").add({
      usuario_id: reservaModificada.usuario_id,
      reserva_id: reservaId,
      tipo: "reserva_modificada",
      mensaje: `Reserva ${reservaId} actualizada por ${req.perfil.nombre_completo} (${reservaModificada.tipo_vuelo}, ${reservaModificada.horas_estimadas} h, estatus: ${reservaModificada.estatus}).`,
      leida: false,
      creada_en: FieldValue.serverTimestamp(),
    });

    res.json({
      mensaje: "Reserva modificada en SQL (RLS) y sincronizada con NoSQL.",
      reserva: reservaModificada,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// UPDATE HIBRIDO: Completar vuelo (restringido a admin/empleado/administrador)
app.put(
  "/api/reservas/:reservaId/completar",
  requerirAuth,
  requerirRol(["admin", "empleado", "administrador"]),
  async (req, res) => {
    try {
      const { reservaId } = req.params;
      const {
        horas_reales,
        novedades_mecanicas = "Sin novedades",
        observaciones_instructor = "Vuelo completado",
      } = req.body;

      const { data: reserva, error: errRes } = await req.sb
        .from("reservas")
        .select("*")
        .eq("reserva_id", reservaId)
        .single();

      if (errRes || !reserva) {
        return res.status(404).json({ error: "Reserva no encontrada." });
      }

      const horasAplicar = Number(horas_reales || reserva.horas_estimadas);

      const { error: errUpdRes } = await req.sb
        .from("reservas")
        .update({ estatus: "completada" })
        .eq("reserva_id", reservaId);

      if (errUpdRes) return res.status(400).json({ error: errUpdRes.message });

      const { data: aeronave } = await req.sb
        .from("aeronaves")
        .select("horas_celula_totales")
        .eq("aeronave_id", reserva.aeronave_id)
        .single();

      if (aeronave) {
        const nuevasHorasAvion = Number(aeronave.horas_celula_totales) + horasAplicar;
        await req.sb
          .from("aeronaves")
          .update({ horas_celula_totales: nuevasHorasAvion })
          .eq("aeronave_id", reserva.aeronave_id);
      }

      const { data: alumno } = await req.sb
        .from("usuarios")
        .select("saldo_horas")
        .eq("usuario_id", reserva.usuario_id)
        .single();

      if (alumno) {
        const nuevoSaldo = Math.max(0, Number(alumno.saldo_horas) - horasAplicar);
        await req.sb
          .from("usuarios")
          .update({ saldo_horas: nuevoSaldo })
          .eq("usuario_id", reserva.usuario_id);
      }

      const snap = await dbFirestore
        .collection("bitacoras_vuelo_y_checklists")
        .where("reserva_id", "==", reservaId)
        .get();

      for (const doc of snap.docs) {
        await doc.ref.update({
          "reporte_postvuelo.novedades_mecanicas": novedades_mecanicas,
          "reporte_postvuelo.observaciones_instructor": observaciones_instructor,
          "reporte_postvuelo.horas_registradas": horasAplicar,
          actualizado_en: FieldValue.serverTimestamp(),
        });
      }

      await dbFirestore.collection("notificaciones_y_alertas").add({
        usuario_id: reserva.usuario_id,
        reserva_id: reservaId,
        tipo: "vuelo_completado",
        mensaje: `Vuelo completado por ${req.perfil.nombre_completo} (${horasAplicar} h registradas). Bitacora actualizada.`,
        leida: false,
        creada_en: FieldValue.serverTimestamp(),
      });

      res.json({ mensaje: "Vuelo completado y sincronizado en SQL y NoSQL." });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// DELETE HIBRIDO: Eliminar reserva (restringido a admin/empleado/administrador por RLS y middleware)
app.delete(
  "/api/reservas/:reservaId",
  requerirAuth,
  requerirRol(["admin", "empleado", "administrador"]),
  async (req, res) => {
    try {
      const { reservaId } = req.params;

      const { data: reserva, error: errGet } = await req.sb
        .from("reservas")
        .select("*")
        .eq("reserva_id", reservaId)
        .single();

      if (errGet || !reserva) {
        return res.status(404).json({ error: "Reserva no encontrada." });
      }

      const { error: errDel } = await req.sb
        .from("reservas")
        .delete()
        .eq("reserva_id", reservaId);

      if (errDel) return res.status(400).json({ error: errDel.message });

      await dbFirestore.collection("notificaciones_y_alertas").add({
        usuario_id: reserva.usuario_id,
        reserva_id: reservaId,
        tipo: "reserva_cancelada",
        mensaje: `Reserva ${reservaId} eliminada por ${req.perfil.nombre_completo}. Horario liberado.`,
        leida: false,
        creada_en: FieldValue.serverTimestamp(),
      });

      res.json({ mensaje: "Reserva eliminada en SQL y alerta registrada en NoSQL." });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

app.listen(PORT, () => {
  console.log(`Servidor RentFly escuchando en http://localhost:${PORT}`);
});