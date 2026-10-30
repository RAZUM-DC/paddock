#!/bin/bash
# Functional test of paddock-guard.nft in throwaway network namespaces (prefix pgt-), cleaned up at the end.
# Needs root, iproute2, nft, python3. Usage: sudo ./paddock-guard-test.sh ./paddock-guard.nft   (every line must say PASS)
# Touches no existing interface or ruleset: all bridges and the ruleset live inside the pgt-r namespace.
set -u
RULES=$1
# net.bridge.* sysctls are per network namespace since Linux 5.3; on older kernels this script would flip the host's.
v=$(uname -r); maj=${v%%.*}; min=${v#*.}; min=${min%%.*}
if [ "$maj" -lt 5 ] || { [ "$maj" -eq 5 ] && [ "$min" -lt 3 ]; }; then echo "kernel $v < 5.3: not running"; exit 1; fi
NS="pgt-r pgt-a pgt-w pgt-e pgt-v pgt-p pgt-c pgt-g"
cleanup() { for n in $NS; do ip netns pids $n 2>/dev/null | xargs -r kill 2>/dev/null; ip netns del $n 2>/dev/null; done; }
cleanup
for n in $NS; do ip netns add $n; ip -n $n link set lo up; done
R="ip netns exec pgt-r"
$R sysctl -qw net.ipv4.ip_forward=1
$R ip link add pu000000000001 type bridge; $R ip addr add 10.210.0.1/26 dev pu000000000001; $R ip link set pu000000000001 up
$R ip link add pd-out type bridge; $R ip addr add 10.211.0.1/24 dev pd-out; $R ip link set pd-out up
port() { # ns ip bridge-or-none peer-ip-in-R/prefix
  ip link add v-$1 type veth peer name e0 netns pgt-$1
  ip link set v-$1 netns pgt-r
  ip -n pgt-$1 addr add $2 dev e0; ip -n pgt-$1 link set e0 up
  if [ "$3" != none ]; then $R ip link set v-$1 master $3; else $R ip addr add $4 dev v-$1; fi
  $R ip link set v-$1 up
}
$R ip link add pd-core type bridge; $R ip addr add 172.20.1.1/24 dev pd-core; $R ip link set pd-core up
port c 172.20.1.5/24 pd-core
port g 172.20.1.6/24 pd-core
port a 10.210.0.2/26 pu000000000001; ip -n pgt-a route add default via 10.210.0.1
port w 10.210.0.3/26 pu000000000001; ip -n pgt-w route add default via 10.210.0.1
port e 10.211.0.2/24 pd-out;          ip -n pgt-e route add default via 10.211.0.1
port v 10.30.0.2/24 none 10.30.0.1/24; ip -n pgt-v route add default via 10.30.0.1
port p 203.0.113.2/24 none 203.0.113.1/24; ip -n pgt-p route add default via 203.0.113.1
srv() { ip netns exec pgt-$1 python3 -c "
import socket,threading
def s(p):
  k=socket.socket(); k.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); k.bind(('0.0.0.0',p)); k.listen(50)
  while True:
    c,_=k.accept(); c.sendall(b'ok'); c.close()
for p in [${2}]: threading.Thread(target=s,args=(p,),daemon=True).start()
threading.Event().wait()" & }
srv w 3000,3001,18080; srv g 8080,18080; srv a 4500,4501; srv v 80,53; srv p 80; srv r 22,9
sleep 1
try() { # label ns ip port expect(open|blocked)
  out=$(ip netns exec pgt-$2 python3 -c "
import socket,sys
s=socket.socket(); s.settimeout(1.5)
try: s.connect(('$3',$4)); print('open')
except socket.timeout: print('blocked')
except ConnectionRefusedError: print('refused')
except OSError as e: print('err',e)")
  [ "$out" = "$5" ] && r=PASS || r=FAIL
  echo "$r  $1: $2 -> $3:$4 = $out (want $5)"
}
echo "== without the ruleset, br_netfilter on"
$R sysctl -qw net.bridge.bridge-nf-call-iptables=1
try "baseline pu other port" a 10.210.0.3 3001 open
try "baseline pd-out to private" e 10.30.0.2 80 open
$R nft -f "$RULES" || exit 1
echo "== with the ruleset, br_netfilter on"
try "harness -> web:3000" a 10.210.0.3 3000 open
try "web -> harness:4500" w 10.210.0.2 4500 open
try "harness -> web:3001" a 10.210.0.3 3001 blocked
try "web -> harness:4501" w 10.210.0.2 4501 blocked
try "harness -> egress api :18080" a 10.210.0.3 18080 blocked
try "core legacy harness -> egress:8080" c 172.20.1.6 8080 open
try "core legacy harness -> egress api :18080" c 172.20.1.6 18080 blocked
try "harness -> host sshd" a 10.210.0.1 22 blocked
try "outside -> host" e 10.211.0.1 9 blocked
try "outside -> VPC" e 10.30.0.2 80 blocked
try "outside -> public" e 203.0.113.2 80 open
try "VPC -> outside (inbound, not from pd-out)" v 10.211.0.2 80 refused
$R nft add element inet paddock_guard outside_allow4 "{ 10.30.0.2 . 53 }"
try "outside -> VPC resolver via outside_allow4" e 10.30.0.2 53 open
try "outside -> VPC other port still dropped" e 10.30.0.2 80 blocked
echo "== with the ruleset, br_netfilter OFF (bridge-nf-call-iptables=0)"
$R sysctl -qw net.bridge.bridge-nf-call-iptables=0
try "harness -> web:3001 NOT filtered" a 10.210.0.3 3001 open
try "outside -> VPC still dropped (routed)" e 10.30.0.2 80 blocked
$R nft list chain inet paddock_guard forward | grep -E "counter" | sed 's/^\s*/   /'
cleanup
