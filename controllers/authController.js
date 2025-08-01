const { db } = require('../db');

exports.login = async (req, res) => {
    const { usuario, contrasena } = req.body;

    try {
        const [rows] = await db.query(
            'SELECT * FROM usuarios WHERE usuario = ? AND contrasena = ?',
            [usuario, contrasena]
        );

        if (rows.length > 0) {
            req.session.user = {
                id: rows[0].id,
                nombre: rows[0].nombre,
                sucursal_codigo: rows[0].sucursal_codigo,
                usuario: rows[0].usuario
            };
            res.redirect('/home');
        } else {
            res.render('login', { error: '❌ Usuario o contraseña incorrectos' });
        }
    } catch (err) {
        console.error(err);
        res.render('login', { error: '⚠️ Error en el login' });
    }
};

exports.home = (req, res) => {
    if (!req.session.user) {
        return res.redirect('/');
    }
    res.render('home', { user: req.session.user });
};

exports.logout = (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
};
