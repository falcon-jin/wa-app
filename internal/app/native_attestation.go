package app

type waSafeEnvelope struct {
	Body          string
	Enc           string
	Authorization string
}

func buildWASafeEnvelope(plain []byte, serverPublicKeyHex string) (waSafeEnvelope, error) {
	enc, err := encryptWASafe(plain, serverPublicKeyHex)
	if err != nil {
		return waSafeEnvelope{}, err
	}
	// The APK keeps the H form key even when AndroidKeyStore attestation is not
	// available, but it does not synthesize a software certificate chain. Sending
	// a fake Authorization chain is distinguishable from the real app path and
	// causes registration risk decisions to drift.
	return waSafeEnvelope{Body: "ENC=" + enc + "&H=", Enc: enc}, nil
}
