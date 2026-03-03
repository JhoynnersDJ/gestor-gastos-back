const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bcrypt = require('bcryptjs');
require('dotenv').config();
const app = express();
const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https'); // 1. Importa el módulo nativo https

// Middlewares
app.use(cors());
app.use(express.json()); // Permite recibir datos en formato JSON

const obtenerTasaBCV = async () => {
  try {
    // 2. Crea un agente que ignore la verificación del certificado
    const agent = new https.Agent({  
      rejectUnauthorized: false
    });

    const { data } = await axios.get('https://www.bcv.org.ve/', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      httpsAgent: agent // agente de axios
    });

    const $ = cheerio.load(data);
    const tasaRaw = $('#dolar strong').text().trim();
    const tasaLimpia = parseFloat(tasaRaw.replace(',', '.'));
    
    console.log("Tasa obtenida exitosamente:", tasaLimpia);
    return tasaLimpia;
  } catch (error) {
    console.error("Error al obtener tasa del BCV:", error.message);
    return 60.00; // Valor de respaldo
  }
};
// Endpoint para que el Frontend la pida
app.get('/api/tasa-bcv', async (req, res) => {
  const tasa = await obtenerTasaBCV();
  res.json({ tasa });
});

// Configuración de la conexión a MySQL
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

// Conectar a la base de datos
db.connect((err) => {
    if (err) {
        console.error('Error conectando a la base de datos: ' + err.stack);
        return;
    }
    console.log('Conectado a la base de datos MySQL con éxito.');
});






////////////////////////////////////////

// Ruta para registrar usuarios
app.post('/api/usuarios/registro', async (req, res) => {
    const { nombre, email, password } = req.body;

    // 1. Encriptar la contraseña
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // 2. Insertar en la base de datos
    const query = 'INSERT INTO usuarios (nombre, email, password) VALUES (?, ?, ?)';
    
    db.query(query, [nombre, email, hashedPassword], (err, result) => {
        if (err) {
            if (err.code === 'ER_DUP_ENTRY') {
                return res.status(400).json({ error: 'El email ya está registrado' });
            }
            return res.status(500).json({ error: err.message });
        }
        res.status(201).json({ mensaje: 'Usuario creado con éxito', id: result.insertId });
    });
});

// Ruta para registrar un nuevo gasto o ingreso
app.post('/api/transacciones', (req, res) => {
    const { usuario_id, categoria_id, monto, tipo, descripcion, fecha } = req.body;

    const query = `
        INSERT INTO transacciones (usuario_id, categoria_id, monto, tipo, descripcion, fecha) 
        VALUES (?, ?, ?, ?, ?, ?)
    `;

    db.query(query, [usuario_id, categoria_id, monto, tipo, descripcion, fecha], (err, result) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.status(201).json({ mensaje: 'Transacción registrada', id: result.insertId });
    });
});

app.get('/api/usuarios/:id/transacciones', (req, res) => {
    const { id } = req.params;
    // Traemos las últimas 10, de la más nueva a la más vieja
    const sql = 'SELECT * FROM transacciones WHERE usuario_id = ? ORDER BY fecha DESC, id DESC LIMIT 10';
    db.query(sql, [id], (err, results) => {
        if (err) return res.status(500).json(err);
        res.json(results);
    });
});

app.get('/api/transacciones/usuario/:id', (req, res) => {
    const usuarioId = req.params.id;
    const { mes, anio } = req.query; // Leemos los datos que envía el frontend

    // 1. Base de la consulta con el JOIN que ya tenías
    let query = `
        SELECT t.*, c.nombre_categoria AS categoria_nombre 
        FROM transacciones t 
        JOIN categorias c ON t.categoria_id = c.id 
        WHERE t.usuario_id = ?
    `;
    
    const params = [usuarioId];

    // 2. Si el frontend envía mes y año, los agregamos al WHERE
    if (mes && anio) {
        query += ` AND MONTH(t.fecha) = ? AND YEAR(t.fecha) = ?`;
        params.push(mes, anio);
    }

    // 3. Ordenamos por fecha
    query += ` ORDER BY t.fecha DESC`;

    db.query(query, params, (err, results) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(results);
    });
});

app.get('/api/transacciones/:id/balance/', (req, res) => {
    const usuarioId = req.params.id;

    // 1. Primero verificamos si el usuario existe
    db.query('SELECT id FROM usuarios WHERE id = ?', [usuarioId], (err, userResults) => {
        if (err) return res.status(500).json({ error: err.message });

        if (userResults.length === 0) {
            return res.status(404).json({ error: 'El usuario no existe' });
        }

        // 2. Si existe, procedemos con el cálculo que ya tenías
        const queryBalance = `
            SELECT 
                SUM(CASE WHEN tipo = 'ingreso' THEN monto ELSE 0 END) AS total_ingresos,
                SUM(CASE WHEN tipo = 'egreso' THEN monto ELSE 0 END) AS total_egresos
            FROM transacciones 
            WHERE usuario_id = ?
        `;

        db.query(queryBalance, [usuarioId], (err, results) => {
            if (err) return res.status(500).json({ error: err.message });
            
            const { total_ingresos, total_egresos } = results[0];
            const balance_neto = (total_ingresos || 0) - (total_egresos || 0);

            res.json({
                usuario_id: usuarioId,
                ingresos: total_ingresos || 0,
                egresos: total_egresos || 0,
                balance: balance_neto
            });
        });
    });
});

//Editar transacciones
app.put('/api/transacciones/:id', (req, res) => {
    const { id } = req.params;
    const { categoria_id, monto, tipo, descripcion, fecha } = req.body;

    const query = `
        UPDATE transacciones 
        SET categoria_id = ?, monto = ?, tipo = ?, descripcion = ?, fecha = ? 
        WHERE id = ?
    `;

    db.query(query, [categoria_id, monto, tipo, descripcion, fecha, id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Transacción no encontrada' });
        }

        res.json({ mensaje: 'Transacción actualizada con éxito' });
    });
});

//Eliminar transacciones
app.delete('/api/transacciones/:id', (req, res) => {
    const { id } = req.params;

    const query = 'DELETE FROM transacciones WHERE id = ?';

    db.query(query, [id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Transacción no encontrada' });
        }

        res.json({ mensaje: 'Transacción eliminada correctamente' });
    });
});

app.post('/api/usuarios/login', (req, res) => {
    const { email, password } = req.body;

    const query = 'SELECT * FROM usuarios WHERE email = ?';
    db.query(query, [email], async (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        
        if (results.length === 0) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        const usuario = results[0];

        // Comparar contraseña enviada con el hash de la DB
        const passwordCorrecto = await bcrypt.compare(password, usuario.password);

        if (!passwordCorrecto) {
            return res.status(401).json({ error: 'Contraseña incorrecta' });
        }

        res.json({ 
            mensaje: 'Login exitoso', 
            usuario: { id: usuario.id, nombre: usuario.nombre, email: usuario.email } 
        });
    });
});

app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Algo salió mal en el servidor!');
});

/////////////////////////////////////////////////







// Ruta de prueba para verificar que funciona
app.get('/', (req, res) => {
    res.send('Servidor del Gestor de Gastos funcionando 🚀');
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});