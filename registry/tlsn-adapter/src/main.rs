//! TLSNotary alpha.14 adapter for the public TCE-SP host only.
//! local-prove is a development trust model: prover and notary share a host.
//! It is NOT an independent Ethereum Foundation notary service.
use anyhow::{anyhow, bail, ensure, Result};
use std::{env, fs, path::Path, time::Duration};
use tokio::{io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt}, sync::oneshot};
use tokio_util::compat::{FuturesAsyncReadCompatExt, TokioAsyncReadCompatExt};
use tlsn::{
    attestation::{
        request::{Request as AttestationRequest, RequestConfig},
        signing::Secp256k1Signer,
        presentation::{Presentation, PresentationOutput},
        Attestation, AttestationConfig, CryptoProvider, Secrets,
    },
    config::{prove::ProveConfig, prover::ProverConfig, tls::TlsClientConfig,
        tls_commit::{mpc::MpcTlsConfig, TlsCommitConfig}, verifier::VerifierConfig},
    connection::{ConnectionInfo, HandshakeData, ServerName, TranscriptLength},
    prover::{state::Committed, Prover, ProverOutput},
    transcript::{ContentType, TranscriptCommitConfig},
    verifier::{ServerCertVerifier, VerifierOutput},
    webpki::RootCertStore,
    Session,
};

const DOMAIN: &str = "doe.tce.sp.gov.br";
const MAX_RECV: usize = 128 * 1024;

fn crypto() -> Result<CryptoProvider> {
    Ok(CryptoProvider { cert: ServerCertVerifier::new(&RootCertStore::mozilla())?, ..Default::default() })
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("local-prove") if args.len() == 5 || args.len() == 7 => {
            // No URL parameters or request-header injection; routing is restricted further by the app.
            let path = args[2].clone();
            ensure!((path.starts_with("/json/file/") || path.starts_with("/pdf/")) &&
                path.bytes().all(|b| b.is_ascii_alphanumeric() || b"/-_.".contains(&b)) &&
                !path.contains("..") && path.len() < 256, "unsupported TCE path");
            let key = fs::read(&args[3])?;
            ensure!(key.len() == 32, "invalid local notary key file");
            let dir = Path::new(&args[4]);
            fs::create_dir_all(dir)?;
            let extra = if args.len() == 7 {
                ensure!(args[5].starts_with("bytes=") && args[5][6..].bytes().all(|b| b.is_ascii_digit() || b == b'-'), "invalid range");
                ensure!(args[6].starts_with('"') && args[6].ends_with('"') && args[6].len() < 128 && args[6].bytes().all(|b| b.is_ascii_alphanumeric() || b"\"-_.:".contains(&b)), "invalid strong ETag");
                format!("Range: {}\r\nIf-Match: {}\r\n", args[5], args[6])
            } else { String::new() };
            tokio::time::timeout(Duration::from_secs(180), local_prove(&path, key, dir, &extra)).await??;
        }
        Some("verify") if args.len() == 5 => {
            // Public key is pinned by deployment config, never trusted merely because it is in a proof.
            verify(Path::new(&args[2]), &args[3], Path::new(&args[4]))?;
        }
        _ => bail!("usage: rbb-tlsn-adapter local-prove PATH KEY_FILE OUT_DIR | verify PRESENTATION PINNED_PUBLIC_KEY OUT_DIR"),
    }
    Ok(())
}

async fn local_prove(path: &str, key: Vec<u8>, dir: &Path, extra: &str) -> Result<()> {
    let (notary_socket, prover_socket) = tokio::io::duplex(1 << 23);
    let (req_tx, req_rx) = oneshot::channel();
    let (att_tx, att_rx) = oneshot::channel();
    let key_public = hex::encode(k256::ecdsa::SigningKey::from_slice(&key)?.verifying_key().to_encoded_point(true).as_bytes());
    let notary_task = tokio::spawn(notary(notary_socket, req_rx, att_tx, key));
    let session = Session::new(prover_socket.compat());
    let (driver, mut handle) = session.split();
    let driver_task = tokio::spawn(driver);
    let prover = handle.new_prover(ProverConfig::builder().build()?)?
        .commit(TlsCommitConfig::builder().protocol(MpcTlsConfig::builder()
            .max_sent_data(1024).max_recv_data(MAX_RECV)
            .max_recv_data_online(0).defer_decryption_from_start(true).build()?).build()?).await?;
    let socket = tokio::net::TcpStream::connect((DOMAIN, 443)).await?;
    let (connection, future) = prover.connect(TlsClientConfig::builder()
        .server_name(ServerName::Dns(DOMAIN.try_into()?))
        .root_store(RootCertStore::mozilla()).build()?, socket.compat()).await?;
    let prover_task = tokio::spawn(future);
    let mut io = connection.compat();
    let request = format!("GET {path} HTTP/1.1\r\nHost: {DOMAIN}\r\nAccept: */*\r\nAccept-Encoding: identity\r\nConnection: close\r\n{extra}User-Agent: RBB-Publication-Prototype/1\r\n\r\n");
    io.write_all(request.as_bytes()).await?;
    io.flush().await?;
    let mut response = Vec::new();
    (&mut io).take((MAX_RECV + 1) as u64).read_to_end(&mut response).await?;
    ensure!(response.len() <= MAX_RECV, "response exceeds limit");
    drop(io);
    let prover = prover_task.await??;
    let mut commits = TranscriptCommitConfig::builder(prover.transcript());
    commits.commit_sent(&(0..prover.transcript().sent().len()))?;
    commits.commit_recv(&(0..prover.transcript().received().len()))?;
    let mut config = RequestConfig::builder();
    config.transcript_commit(commits.build()?);
    let (attestation, secrets) = notarize(prover, &config.build()?, req_tx, att_rx).await?;
    handle.close(); driver_task.await??; notary_task.await??;
    let mut transcript = secrets.transcript_proof_builder();
    transcript.reveal_sent(&(0..secrets.transcript().sent().len()))?;
    transcript.reveal_recv(&(0..secrets.transcript().received().len()))?;
    let provider = crypto()?;
    let mut presentation = attestation.presentation_builder(&provider);
    presentation.identity_proof(secrets.identity_proof()).transcript_proof(transcript.build()?);
    let presentation = presentation.build()?;
    let path = dir.join("presentation.tlsn");
    fs::write(&path, bincode::serialize(&presentation)?)?;
    // No session secrets are persisted. This public-data proof reveals the complete transcript.
    verify(&path, &key_public, dir)?;
    Ok(())
}

fn verify(path: &Path, expected_key: &str, dir: &Path) -> Result<()> {
    ensure!(fs::metadata(path)?.len() < 32 * 1024 * 1024, "presentation exceeds limit");
    let presentation: Presentation = bincode::deserialize(&fs::read(path)?)?;
    ensure!(hex::encode(&presentation.verifying_key().data) == expected_key, "untrusted notary key");
    let PresentationOutput { server_name, connection_info, transcript, .. } = presentation.verify(&crypto()?)?;
    let server = server_name.ok_or_else(|| anyhow!("missing server identity"))?.to_string();
    ensure!(server == DOMAIN, "unexpected server identity");
    let transcript = transcript.ok_or_else(|| anyhow!("missing transcript"))?;
    ensure!(transcript.is_complete(), "redacted or unauthenticated transcript bytes");
    ensure!(transcript.len_received() <= MAX_RECV, "transcript exceeds limit");
    fs::create_dir_all(dir)?;
    fs::write(dir.join("sent.http"), transcript.sent_unsafe())?;
    fs::write(dir.join("received.http"), transcript.received_unsafe())?;
    let result = serde_json::json!({"schema":"rbb-tlsn-session/v1", "serverName":server,
        "observedAt":connection_info.time,"notaryPublicKey":expected_key,"tlsVersion":format!("{:?}",connection_info.version),
        "completeTranscript":true,"trustModel":"local-notary","tlsnVersion":"0.1.0-alpha.14"});
    fs::write(dir.join("verified.json"), serde_json::to_vec_pretty(&result)?)?;
    println!("{}", result);
    Ok(())
}

async fn notarize(mut prover: Prover<Committed>, config: &RequestConfig,
    request_tx: oneshot::Sender<AttestationRequest>, attestation_rx: oneshot::Receiver<Attestation>) -> Result<(Attestation, Secrets)> {
    let mut builder = ProveConfig::builder(prover.transcript());
    builder.transcript_commit(config.transcript_commit().unwrap().clone());
    let ProverOutput { transcript_commitments, transcript_secrets, .. } = prover.prove(&builder.build()?).await?;
    let transcript = prover.transcript().clone();
    let tls = prover.tls_transcript().clone();
    prover.close().await?;
    let mut builder = AttestationRequest::builder(config);
    builder.server_name(ServerName::Dns(DOMAIN.try_into()?))
        .handshake_data(HandshakeData { certs: tls.server_cert_chain().ok_or_else(|| anyhow!("no certificates"))?.to_vec(),
            sig: tls.server_signature().ok_or_else(|| anyhow!("no server signature"))?.clone(), binding: tls.certificate_binding().clone() })
        .transcript(transcript).transcript_commitments(transcript_secrets, transcript_commitments);
    let (request, secrets) = builder.build(&crypto()?)?;
    request_tx.send(request.clone()).map_err(|_| anyhow!("notary request failed"))?;
    let attestation = attestation_rx.await?;
    request.validate(&attestation, &crypto()?)?;
    Ok((attestation, secrets))
}

async fn notary<S: AsyncWrite + AsyncRead + Send + Sync + Unpin + 'static>(socket: S,
    request_rx: oneshot::Receiver<AttestationRequest>, attestation_tx: oneshot::Sender<Attestation>, key: Vec<u8>) -> Result<()> {
    let session = Session::new(socket.compat());
    let (driver, mut handle) = session.split();
    let driver_task = tokio::spawn(driver);
    let verifier = handle.new_verifier(VerifierConfig::builder().root_store(RootCertStore::mozilla()).build()?)?
        .commit().await?.accept().await?.run().await?;
    let (VerifierOutput { transcript_commitments, .. }, verifier) = verifier.verify().await?.accept().await?;
    let tls = verifier.tls_transcript().clone();
    verifier.close().await?;
    let sent = tls.sent().iter().filter(|r| matches!(r.typ, ContentType::ApplicationData)).map(|r| r.ciphertext.len()).sum::<usize>();
    let received = tls.recv().iter().filter(|r| matches!(r.typ, ContentType::ApplicationData)).map(|r| r.ciphertext.len()).sum::<usize>();
    let request = request_rx.await?;
    let mut provider = crypto()?;
    provider.signer.set_signer(Box::new(Secp256k1Signer::new(&key)?));
    let mut config = AttestationConfig::builder();
    config.supported_signature_algs(Vec::from_iter(provider.signer.supported_algs()));
    let config = config.build()?;
    let mut builder = Attestation::builder(&config).accept_request(request)?;
    builder.connection_info(ConnectionInfo { time: tls.time(), version: *tls.version(),
        transcript_length: TranscriptLength { sent: sent as u32, received: received as u32 } })
        .server_ephemeral_key(tls.server_ephemeral_key().clone()).transcript_commitments(transcript_commitments);
    attestation_tx.send(builder.build(&provider)?).map_err(|_| anyhow!("prover response failed"))?;
    handle.close(); driver_task.await??;
    Ok(())
}
