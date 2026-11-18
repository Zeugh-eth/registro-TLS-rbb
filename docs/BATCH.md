# Lotes de edições

O executor descobre as edições em uma janela inclusiva de até 365 dias, inclui
extras, distingue dias sem edição de falhas de calendário e pula registros já
confirmados. O contrato, rede, genesis, writer e verificador de referência são
fixados em `registry/lib/publication-batch.mjs`.

## Planejar e consultar

Com o app local disponível, a partir de `registry/`:

```sh
npm run batch:plan -- --end YYYY-MM-DD
npm run batch:run -- --end YYYY-MM-DD
```

O segundo comando é somente leitura: sem `--execute`, não carrega chave nem envia
transações. O inventário fica em `state/batches/<início>_<fim>/plan.json`.

## Configurar e executar

Somente o operador da carteira autorizada pode executar o lote de referência.
Use uma conta exclusiva de testes. Nunca envie chave ou frase de recuperação pelo
chat, commit, argumento de processo ou formulário web.

```sh
npm run batch:key
npm run batch:run -- --end YYYY-MM-DD --execute
```

O primeiro comando oculta a entrada, confere o endereço derivado e salva a chave
individual em `state/secrets/batch-writer.key`: arquivo 0600, diretório 0700,
sem criptografia em disco. O executor CLI carrega essa chave; o servidor HTTP e
o navegador não a recebem. A chave continua controlando a conta em outras redes.

Para iniciar um processo destacado e retomável:

```sh
python3 scripts/start-publication-batch.py --end YYYY-MM-DD
```

Esse launcher usa o Node encontrado no PATH, não herda outras credenciais do shell
e configura transporte direto. Para SSH, rode o executor principal com
`RBB_RPC_TRANSPORT=ssh` e sua configuração de transporte. No macOS o executor usa
`caffeinate` enquanto está ativo. Logs e PID ficam em `state/`, fora do Git.

## Confirmação por documento

1. Lê o contrato e preserva registros existentes.
2. Gera uma prova TLSNotary recente do calendário e de todos os trechos do PDF.
3. Revalida e emite atestação nova, válida por 15 minutos.
4. Valida destino, rede, bytecode, writer/verificador e conteúdo; simula e estima gas.
5. Só admite valor zero, gasPrice zero e gas limit limitado no destino autorizado.
6. Persiste a transação assinada **antes** da tentativa de transmissão.
7. Exige recibo de sucesso, evento correspondente e consulta da primeira data.

O custo dominante é a prova em trechos sequenciais. PDFs maiores têm mais trechos.
O painel de declarações mostra as medianas observadas, sem tratar esses números
como prazo garantido para todo o lote.

## Retomada

Há uma trava global e outra por lote. Evite usar simultaneamente essa carteira no
MetaMask. SIGINT/SIGTERM pede parada ao fim da etapa atual; não encerre à força uma
transação de resultado incerto.

`pending.json` guarda a transação antes do envio. Se o RPC tiver resultado ambíguo,
a execução para e a retomada consulta o mesmo hash, sem assinar um nonce substituto.
Transações revertidas preservam o recibo e interrompem o lote.

Falhas de prova permanecem visíveis e não contam como registros. Após corrigir a
causa, use `--retry-failed` no executor ou launcher. Uma prova anterior com status
`failed` pode ser lida para solicitar uma coleta nova; isso não ignora erros HTTP.
Três falhas consecutivas interrompem a execução. Há também um limite mínimo de
espaço livre em disco.

`runComplete: true` só aparece quando todos os PDFs do inventário estão registrados.
Edições antigas recebem o horário real de inclusão atual, sem retroatividade.
