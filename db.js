const mysql = require('mysql2/promise');
require('dotenv').config();

// Base de datos principal (Railway)
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// Base de datos externa (Plex)
const plex = mysql.createPool({
  host: '192.168.5.202',
  port: 3307,
  user: 'sistemas',
  password: 'S1nch2z@nt4n34ll320',
  database: 'onze_center', // si el nombre exacto es distinto avisame
});

module.exports = {
  db: pool,
  plex: plex
};
