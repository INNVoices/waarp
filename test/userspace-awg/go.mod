module waarp-audit-userspace

go 1.26.0

toolchain go1.26.11

require github.com/sagernet/wireguard-go v0.0.8-0.20260929150556-6731c7387c81

require (
	github.com/sagernet/sing v0.9.7-0.20260929150544-0ad23b637bd4 // indirect
	golang.org/x/crypto v0.54.0 // indirect
	golang.org/x/net v0.57.0 // indirect
	golang.org/x/sys v0.47.0 // indirect
	golang.zx2c4.com/wintun v0.0.0-20230126152724-0fa3db229ce2 // indirect
)

replace github.com/sagernet/wireguard-go => github.com/Leadaxe/wireguard-go-awg2-lx v0.0.0-20260929174416-64065e6826ad
