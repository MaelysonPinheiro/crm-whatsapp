const sqlite3 = require('sqlite3').verbose();

// Cria/Abre o arquivo de banco de dados na pasta do projeto
const db = new sqlite3.Database('./sistema_fila.db', (err) => {
    if (err) {
        console.error('Erro ao abrir o banco de dados:', err.message);
    } else {
        console.log('📦 Conectado ao banco de dados SQLite com sucesso!');
    }
});

// Cria as tabelas iniciais se elas não existirem
db.serialize(() => {
    // Tabela de Consultores
    db.run(`CREATE TABLE IF NOT EXISTS consultores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nome TEXT NOT NULL,
        telefone TEXT NOT NULL UNIQUE,
        ativo INTEGER DEFAULT 1
    )`);

    // Tabela de Atendimentos / Fila
    db.run(`CREATE TABLE IF NOT EXISTS atendimentos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cliente_telefone TEXT NOT NULL,
        consultor_id INTEGER,
        status TEXT DEFAULT 'aguardando', -- aguardando, em_atendimento, finalizado
        limite_tempo DATETIME,
        FOREIGN KEY (consultor_id) REFERENCES consultores (id)
    )`);
});

module.exports = db;