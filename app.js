// app.js
const express = require('express');
const session = require('express-session');
const path = require('path');
require('dotenv').config();

const authRoutes = require('./routes/auth');    // <— aquí importa routes/auth.js

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || 'clave_ultrasecreta',
  resave: false,
  saveUninitialized: false
}));

// para que ejs pueda leer `session` en todas las vistas
app.use((req, res, next) => {
  res.locals.session = req.session;
  next();
});

// monta TODAS las rutas que tenemos en routes/auth.js
app.use('/', authRoutes);

app.listen(3000, () => console.log('Servidor corriendo en http://localhost:3000'));
