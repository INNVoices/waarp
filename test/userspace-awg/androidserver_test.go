// SPDX-License-Identifier: Apache-2.0
package main

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
	"time"

	"github.com/sagernet/wireguard-go/device"
	"golang.org/x/net/dns/dnsmessage"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

func TestAndroidFixtureChild(t *testing.T) {
	port, exists := os.LookupEnv("WAARP_TEST_CHILD_PORT")
	if !exists {
		return
	}
	number, _ := strconv.Atoi(port)
	if executeAndroidServer(number, os.Getenv("WAARP_TEST_CHILD_REPORT")) != nil {
		os.Exit(1)
	}
	os.Exit(0)
}

// Verifies the new fixture itself before asking Android to use it. Two fresh
// client Devices prove authenticated packets, EDNS parsing, and shutdown evidence.
func TestAndroidServerEncryptedEDNSAndClientRecreation(t *testing.T) {
	reserved, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal("reserve_fixture_port")
	}
	port := reserved.LocalAddr().(*net.UDPAddr).Port
	reserved.Close()
	reportPath := filepath.Join(t.TempDir(), "proof.json")
	executable, _ := os.Executable()
	child := exec.Command(executable, "-test.run=^TestAndroidFixtureChild$")
	child.Env = append(os.Environ(), "WAARP_TEST_CHILD_PORT="+strconv.Itoa(port), "WAARP_TEST_CHILD_REPORT="+reportPath)
	if child.Start() != nil {
		t.Fatal("start_fixture")
	}
	finished := false
	done := make(chan error, 1)
	go func() { done <- child.Wait() }()
	t.Cleanup(func() {
		if !finished {
			child.Process.Kill()
			<-done
		}
	})
	client := &http.Client{Timeout: time.Second}
	base := "http://127.0.0.1:" + strconv.Itoa(port)
	ready := false
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		response, requestErr := client.Get(base + "/health")
		if requestErr == nil {
			response.Body.Close()
			if response.StatusCode == http.StatusOK {
				ready = true
				break
			}
		}
		time.Sleep(25 * time.Millisecond)
	}
	if !ready {
		t.Fatal("fixture_not_ready")
	}
	privateKey, _ := ecdh.X25519().GenerateKey(rand.Reader)
	request, _ := json.Marshal(map[string]string{"public_key": base64.StdEncoding.EncodeToString(privateKey.PublicKey().Bytes())})
	response, err := client.Post(base+"/register", "application/json", bytes.NewReader(request))
	if err != nil {
		t.Fatal("register_client")
	}
	var peer struct {
		PublicKey string `json:"server_public_key"`
	}
	decodeErr := json.NewDecoder(response.Body).Decode(&peer)
	response.Body.Close()
	if response.StatusCode != http.StatusOK || decodeErr != nil {
		t.Fatal("register_response")
	}
	publicKey, err := base64.StdEncoding.DecodeString(peer.PublicKey)
	if err != nil || len(publicKey) != 32 {
		t.Fatal("server_public_key")
	}
	for cycle := 0; cycle < 2; cycle++ {
		func() {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			stackTUN, stackNet, stackErr := netstack.CreateNetTUN([]netip.Addr{localClientIP}, nil, 1280)
			if stackErr != nil {
				t.Fatal("client_netstack")
			}
			bind := &udpBind{family: "udp4", listenIP: net.IPv4(127, 0, 0, 1)}
			dev := device.NewDevice(ctx, adaptAndroidNetTUN(stackTUN), bind, &device.Logger{Verbosef: device.DiscardLogf, Errorf: device.DiscardLogf}, 1)
			defer dev.Close()
			uapi := "private_key=" + hex.EncodeToString(privateKey.Bytes()) + "\n" + localAWG +
				"replace_peers=true\npublic_key=" + hex.EncodeToString(publicKey) +
				"\nendpoint=127.0.0.1:" + strconv.Itoa(port) + "\nallowed_ip=10.77.0.1/32\n"
			if dev.IpcSet(uapi) != nil || dev.Up() != nil {
				t.Fatal("start_client")
			}
			nonce := fmt.Sprintf("host-fixture-cycle-%d", cycle)
			for _, domain := range []string{"example.com.", nonce + ".soak.waarp.test."} {
				query := dnsmessage.Message{
					Header:      dnsmessage.Header{ID: uint16(100 + cycle), RecursionDesired: true},
					Questions:   []dnsmessage.Question{{Name: dnsmessage.MustNewName(domain), Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET}},
					Additionals: []dnsmessage.Resource{{Header: dnsmessage.ResourceHeader{Name: dnsmessage.MustNewName("."), Type: dnsmessage.TypeOPT, Class: dnsmessage.Class(1232)}, Body: &dnsmessage.OPTResource{}}},
				}
				payload, packErr := query.Pack()
				if packErr != nil {
					t.Fatal("encode_edns")
				}
				connection, dialErr := stackNet.DialUDPAddrPort(netip.AddrPortFrom(localClientIP, 0), netip.AddrPortFrom(localServerIP, 53))
				if dialErr != nil {
					t.Fatal("dial_inner_dns")
				}
				answer := make([]byte, 4096)
				matched := false
				for until := time.Now().Add(8 * time.Second); time.Now().Before(until); {
					connection.SetDeadline(time.Now().Add(250 * time.Millisecond))
					if _, writeErr := connection.Write(payload); writeErr != nil {
						t.Fatal("write_inner_dns")
					}
					n, readErr := connection.Read(answer)
					if readErr != nil {
						continue
					}
					var decoded dnsmessage.Message
					if decoded.Unpack(answer[:n]) != nil || decoded.Header.ID != query.Header.ID || decoded.Header.RCode != 0 || len(decoded.Answers) != 1 {
						t.Fatal("inner_dns_response")
					}
					address, ok := decoded.Answers[0].Body.(*dnsmessage.AResource)
					wanted := [4]byte{10, 77, 0, 1}
					if domain == "example.com." {
						wanted = [4]byte{192, 0, 2, 42}
					}
					if !ok || address.A != wanted || decoded.Answers[0].Header.TTL != 0 {
						t.Fatal("inner_dns_address")
					}
					matched = true
					break
				}
				connection.Close()
				if !matched || !handshakeComplete(dev) {
					t.Fatal("encrypted_dns_timeout_or_no_handshake")
				}
			}
			transport := &http.Transport{DialContext: stackNet.DialContext, DisableKeepAlives: true}
			defer transport.CloseIdleConnections()
			innerClient := &http.Client{Transport: transport, Timeout: 8 * time.Second}
			response, requestErr := innerClient.Get("http://10.77.0.1:18080/probe?nonce=" + nonce)
			if requestErr != nil {
				t.Fatal("encrypted_http_request")
			}
			body, bodyErr := io.ReadAll(io.LimitReader(response.Body, androidHTTPPayloadSize+256))
			response.Body.Close()
			prefix := []byte("waarp-acceptance:" + nonce + "\n")
			if bodyErr != nil || response.StatusCode != http.StatusOK || len(body) != len(prefix)+androidHTTPPayloadSize || !bytes.HasPrefix(body, prefix) || !bytes.Equal(body[len(prefix):], bytes.Repeat([]byte{'w'}, androidHTTPPayloadSize)) {
				t.Fatal("encrypted_http_body")
			}
		}()
	}
	child.Process.Signal(syscall.SIGTERM)
	select {
	case err = <-done:
		finished = true
		if err != nil {
			t.Fatal("fixture_shutdown")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("fixture_shutdown_timeout")
	}
	file, err := os.Open(reportPath)
	if err != nil {
		t.Fatal("proof_file")
	}
	defer file.Close()
	var proof androidProof
	if json.NewDecoder(file).Decode(&proof) != nil || !proof.Passed || !proof.HTTPStarted || proof.HTTPRequests != 2 || proof.UniqueHTTP != 2 || proof.UniqueDNS != 3 || proof.HTTPBytes < 2*androidHTTPPayloadSize || proof.FirstRequest <= 0 || proof.LastRequest < proof.FirstRequest {
		t.Fatalf("fixture_proof_failed: %+v", proof)
	}
}
