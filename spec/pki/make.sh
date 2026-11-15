#!/bin/sh
# -- The test PKI ----------------------------------------------------------------------------------
# The one PKI every side's TLS tests read by path (spec 15.39, decision 0053), written by this
# script beside it, run once and again only to renew it. Each key is P-256 in PKCS #8, unencrypted;
# each certificate is X.509 v3 under SHA-256, valid for about a hundred years. Its keys are published
# test keys: spec/check.py holds each to spec/ and the tests, as it holds the JWT verdicts' keys.
#
#   root.pem, root.key                          CN=Bead test root: CA:TRUE, keyCertSign and cRLSign
#   intermediate.pem, intermediate.key          CN=Bead test intermediate, under the root: CA:TRUE,
#                                               pathlen 0, keyCertSign and cRLSign
#   client.pem, client.key                      CN=Bead test client, under the intermediate: CA:FALSE,
#                                               digitalSignature, clientAuth
#   client-chain.pem                            client.pem, then intermediate.pem: a client's
#                                               certificate first, then the one that certifies it
#                                               (RFC 8446 §4.4.2)
#   server.pem, server.key                      CN=localhost, under the root: CA:FALSE,
#                                               digitalSignature, serverAuth, DNS:localhost and
#                                               IP:127.0.0.1
#   stranger-root.pem                           CN=Bead test stranger: CA:TRUE, a root no test trusts,
#                                               its key not kept
#   stranger-client.pem, stranger-client.key    CN=Bead test stranger client, under the stranger
#                                               root: CA:FALSE, digitalSignature, clientAuth
#   stranger-server.pem, stranger-server.key    CN=localhost, under the stranger root: CA:FALSE,
#                                               digitalSignature, serverAuth, DNS:localhost and
#                                               IP:127.0.0.1
#
#   sh spec/pki/make.sh        from any folder, with OpenSSL 1.1.1 or later; its temporary files in
#                              a folder of $TMPDIR's, removed as it ends

set -eu

# Git Bash would rewrite a subject, which starts with /, as a Windows path
MSYS2_ARG_CONV_EXCL=/CN=
export MSYS2_ARG_CONV_EXCL

here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

days=36525

cat > "$work/openssl.cnf" <<'EOF'
[req]
distinguished_name = subject

[subject]

[root]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash

[intermediate]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always

[client]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = clientAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always

[server]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost, IP:127.0.0.1
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
EOF

# a P-256 key in PKCS #8, unencrypted
key() {
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -pkeyopt ec_param_enc:named_curve \
    -out "$1"
}

# a positive serial of 15 random octets, so that a renewed certificate never repeats one
serial() {
  printf '0x%s' "$(openssl rand -hex 15)"
}

# a self-signed root: its key, its subject, the file it is written to
root() {
  openssl req -new -x509 -sha256 -days "$days" -config "$work/openssl.cnf" -extensions root \
    -set_serial "$(serial)" -key "$1" -subj "$2" -out "$3"
}

# a certificate its issuer signs: its key, its subject, its profile, the issuer's certificate and key,
# the file it is written to
issue() {
  openssl req -new -sha256 -config "$work/openssl.cnf" -key "$1" -subj "$2" -out "$work/request.csr"
  openssl x509 -req -sha256 -days "$days" -in "$work/request.csr" -CA "$4" -CAkey "$5" \
    -set_serial "$(serial)" -extfile "$work/openssl.cnf" -extensions "$3" -out "$6"
}

key "$here/root.key"
root "$here/root.key" '/CN=Bead test root' "$here/root.pem"

key "$here/intermediate.key"
issue "$here/intermediate.key" '/CN=Bead test intermediate' intermediate "$here/root.pem" \
  "$here/root.key" "$here/intermediate.pem"

key "$here/client.key"
issue "$here/client.key" '/CN=Bead test client' client "$here/intermediate.pem" \
  "$here/intermediate.key" "$here/client.pem"
cat "$here/client.pem" "$here/intermediate.pem" > "$here/client-chain.pem"

key "$here/server.key"
issue "$here/server.key" '/CN=localhost' server "$here/root.pem" "$here/root.key" "$here/server.pem"

key "$work/stranger-root.key"
root "$work/stranger-root.key" '/CN=Bead test stranger' "$here/stranger-root.pem"

key "$here/stranger-client.key"
issue "$here/stranger-client.key" '/CN=Bead test stranger client' client "$here/stranger-root.pem" \
  "$work/stranger-root.key" "$here/stranger-client.pem"

key "$here/stranger-server.key"
issue "$here/stranger-server.key" '/CN=localhost' server "$here/stranger-root.pem" \
  "$work/stranger-root.key" "$here/stranger-server.pem"
