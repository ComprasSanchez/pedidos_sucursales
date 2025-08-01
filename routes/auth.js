// routes/auth.js
const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const pedidosController = require('../controllers/pedidosController');
const { plex } = require('../db');
const { isAuthenticated } = require('../middlewares/authMiddleware');

// ─── LOGIN ─────────────────────────
router.get('/', (req, res) => {
  res.render('login', { error: null });
});
router.post('/login', authController.login);
router.get('/logout', authController.logout);
router.get('/home', isAuthenticated, authController.home);

// ─── BÚSQUEDA DE PRODUCTOS ──────────
router.get('/buscar-producto', isAuthenticated, (req, res) => {
  res.render('buscar', { resultado: null, error: null, codebar: null });
});
router.post('/buscar-producto', isAuthenticated, async (req, res) => {
  const { codebar } = req.body;
  try {
    const [rows] = await plex.query(`
      SELECT
        pc.codebar AS codigo_barras,
        CONCAT(m.Producto,' ',m.Presentaci) AS descripcion
      FROM productoscodebars pc
      JOIN medicamentos m ON pc.idproducto = m.CodPlex
      WHERE pc.codebar = ?
    `, [codebar]);

    if (rows.length > 0) {
      res.render('buscar', { resultado: rows[0], error: null, codebar });
    } else {
      res.render('buscar', {
        resultado: null,
        error: '❌ Producto no encontrado',
        codebar
      });
    }
  } catch (err) {
    console.error(err);
    res.render('buscar', {
      resultado: null,
      error: '⚠️ Error consultando la base externa',
      codebar
    });
  }
});

// ─── AGREGAR A LISTA (SESION) ──────
router.post('/agregar-carrito', isAuthenticated, (req, res) => {
  const { codigo_barras, descripcion, cantidad } = req.body;
  if (!req.session.carrito) req.session.carrito = [];
  const idx = req.session.carrito.findIndex(i => i.codigo_barras === codigo_barras);
  if (idx > -1) {
    req.session.carrito[idx].cantidad += parseInt(cantidad, 10);
  } else {
    req.session.carrito.push({
      codigo_barras,
      descripcion,
      cantidad: parseInt(cantidad, 10)
    });
  }
  res.redirect('/buscar-producto');
});

// ─── COMPARATIVA ────────────────────
router.route('/comparativa')
  .get(isAuthenticated, pedidosController.comparativa)
  .post(isAuthenticated, pedidosController.comparativa);


module.exports = router;
