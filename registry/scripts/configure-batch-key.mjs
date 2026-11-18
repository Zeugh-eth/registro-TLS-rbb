import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { KEY_FILE, walletFromSecret } from '../lib/publication-batch.mjs';

if (process.argv.includes('--help')) {
  console.log('Execute em seu Terminal: npm run batch:key\nEntrada oculta da chave individual. Nunca use sua frase de recuperação.\nArquivo local, permissão 600: ' + KEY_FILE);
} else {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Execute pessoalmente em um Terminal interativo. Não passe a chave como argumento, variável ou mensagem.');
  console.log('Configuração local da conta de testes 0x43C530588209aC49C1FC6987Af930B9077168Fdb.');
  console.log('A chave ficará em arquivo local sem criptografia, acessível só ao seu usuário (600).');
  console.log('Nenhuma transação será enviada por este comando. Nunca cole sua frase de recuperação.');
  process.stdout.write('Cole a chave individual da conta e pressione Enter (entrada oculta): ');
  let secret = '';
  try {
    secret = await new Promise((resolve, reject) => {
      let input = '';
      process.stdin.setRawMode(true); process.stdin.setEncoding('utf8'); process.stdin.resume();
      const finish = (error, value) => {
        process.stdin.off('data', onData); process.stdin.setRawMode(false); process.stdin.pause();
        process.stdout.write('\n'); error ? reject(error) : resolve(value);
      };
      const onData = data => {
        for (const character of data) {
          if (character === '\u0003' || character === '\u0004') return finish(new Error('Cancelado.'));
          if (character === '\r' || character === '\n') return finish(null, input);
          if (character === '\u007f' || character === '\b') input = input.slice(0, -1);
          else input += character;
          if (input.length > 128) return finish(new Error('Entrada excessiva. Use somente a chave individual.'));
        }
      };
      process.stdin.on('data', onData);
    });
    const wallet = walletFromSecret(secret);
    const directory = path.dirname(KEY_FILE);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error('Pasta de segredos inválida.');
    await fs.chmod(directory, 0o700);
    const handle = await fs.open(KEY_FILE, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(secret.trim() + '\n'); await handle.sync(); } finally { await handle.close(); }
    console.log('Chave configurada para ' + wallet.address + '. Nenhuma transação enviada.');
  } catch (error) {
    console.error(error.code === 'EEXIST' ? 'Já existe uma chave configurada; o arquivo não foi sobrescrito.' : error.message);
    process.exitCode = 1;
  } finally { secret = ''; if (process.stdin.isRaw) process.stdin.setRawMode(false); }
}
