import https from "node:https";
import { X509Certificate } from "node:crypto";
import tls from "node:tls";
import { RUSSIAN_TRUSTED_ROOT_CA_PEM, RUSSIAN_TRUSTED_ROOT_CA_SHA256 } from "./russian-root-ca.js";

type Pem = string | Buffer;

export interface RussianTrustOptions {
  /**
   * More trusted roots/intermediates, PEM. Typically the "Russian Trusted Sub CA" if a server does
   * not send its intermediate certificate (the error is then `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`).
   */
  extraCa?: readonly Pem[];
  /** Other agent options (keepAlive, maxSockets, ...). `ca` is managed by this function. */
  agentOptions?: Omit<https.AgentOptions, "ca">;
}

/**
 * Node's bundled roots (`tls.rootCertificates`) plus the Russian Trusted Root CA.
 * The bundled roots are kept: setting `ca` replaces Node's default list, so it must be re-added.
 */
export function russianTrustCaBundle(extraCa: readonly Pem[] = []): string[] {
  return [...tls.rootCertificates, RUSSIAN_TRUSTED_ROOT_CA_PEM, ...extraCa.map((pem) => pem.toString())];
}

/** An `https.Agent` that trusts public CAs *and* the Russian Trusted Root CA. Use it for T-Bank and Dolyame hosts. */
export function createRussianTrustAgent(options: RussianTrustOptions = {}): https.Agent {
  return new https.Agent({
    keepAlive: true,
    ...options.agentOptions,
    ca: russianTrustCaBundle(options.extraCa),
  });
}

export interface MtlsOptions extends RussianTrustOptions {
  /** Client certificate chain, PEM (issued in the T-Business cabinet for the Dolyame partner API). */
  cert: Pem;
  /** Private key matching `cert`, PEM. */
  key: Pem;
  passphrase?: string;
  /** Add the Russian Trusted Root CA to the trust store. Default true (`partner.dolyame.ru` chains to it). */
  trustRussianRoot?: boolean;
}

/** An `https.Agent` presenting a client certificate (mTLS), trusting public CAs and, by default, the Russian root. */
export function createMtlsAgent(options: MtlsOptions): https.Agent {
  const { cert, key, passphrase, trustRussianRoot = true, extraCa, agentOptions } = options;
  const ca = trustRussianRoot
    ? russianTrustCaBundle(extraCa)
    : [...tls.rootCertificates, ...(extraCa ?? []).map((pem) => pem.toString())];
  return new https.Agent({
    keepAlive: true,
    ...agentOptions,
    cert,
    key,
    ...(passphrase === undefined ? {} : { passphrase }),
    ca,
  });
}

/** SHA-256 fingerprint of a PEM certificate in the `AA:BB:..` form used by openssl. */
export function certificateFingerprint256(pem: Pem): string {
  const certificate = new X509Certificate(pem);
  return certificate.fingerprint256;
}

/** Re-computes the bundled root's fingerprint and compares it with the pinned constant. */
export function isBundledRootIntact(): boolean {
  return certificateFingerprint256(RUSSIAN_TRUSTED_ROOT_CA_PEM) === RUSSIAN_TRUSTED_ROOT_CA_SHA256;
}
