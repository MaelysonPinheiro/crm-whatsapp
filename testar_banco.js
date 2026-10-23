const db = require('./database');

// Cadastrando um consultor de teste
db.run(`INSERT INTO consultores (nome, telefone) VALUES (?, ?)`, ['João Consultor', '5561999999999'], function(err) {
    if (err) {
        console.log('Erro ao cadastrar (talvez o telefone já exista):', err.message);
    } else {
        console.log(`✅ Consultor cadastrado com ID: ${this.lastID}`);
    }
});

// Listando todos os consultores cadastrados
db.all(`SELECT * FROM consultores`, [], (err, rows) => {
    if (err) {
        throw err;
    }
    console.log('👥 Consultores cadastrados no banco:');
    console.table(rows);
});