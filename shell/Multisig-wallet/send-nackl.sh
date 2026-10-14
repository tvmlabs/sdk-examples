#!/usr/bin/env bash
#
# Transfers NACKL from a multisig wallet (a single-custodian
# UpdateCustodianMultisigWallet_v2, e.g. one deployed by deploy-multisig.sh)
# to the given address.
#
# Dependencies: bash, curl, tar, sed, tr (tvm-cli and the ABI are downloaded).

set -euo pipefail
umask 077

TVM_CLI_VERSION=${TVM_CLI_VERSION:-3.0.6.an}
TVM_CLI_MIN=3.0.6
MSIG=UpdateCustodianMultisigWallet_v2
MSIG_URL=https://raw.githubusercontent.com/ackinacki/ackinacki/df524923ef1d2892bf93d239914e94276826d196/contracts/0.81.0_compiled/updatecustodianmultisigwallet_v2
MSIG_CODE_HASH=cfcaac10d43c8dc062298cb48df097be67cddec52b9cfd558309a7549f01c1f1
CACHE_DIR=${ACKI_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/acki-nacki-scripts}
# VMSHELL reserve for gas: a transfer costs about 0.015.
MIN_GAS=50000000

ENDPOINT=${ACKI_ENDPOINT:-mainnet.ackinacki.org}
WALLET_DIR=./msig-wallet
WALLET=
KEYS=
ASSUME_YES=

usage() {
    cat <<EOF
Usage: $(basename "$0") [options] <RECIPIENT> <AMOUNT>

Transfers NACKL from a multisig wallet to the recipient address.

  RECIPIENT               address in the DAPP_ID::ACCOUNT_ID form
  AMOUNT                  amount of NACKL, up to 9 decimal places (e.g. 1.5)

  -u, --url ENDPOINT      network (default: \$ACKI_ENDPOINT or mainnet.ackinacki.org)
  -d, --dir DIR           wallet directory created by deploy-multisig.sh
                          (default: ./msig-wallet)
  -w, --wallet ADDRESS    wallet address DAPP_ID::ACCOUNT_ID (instead of DIR/msig.addr)
  -k, --keys FILE         custodian key file (instead of DIR/msig.keys.json)
  -y, --yes               do not ask for confirmation before sending
  -h, --help              show this help

Environment:
  TVM_CLI           path to tvm-cli (otherwise taken from PATH or downloaded)
  TVM_CLI_VERSION   tvm-cli version to download (default: $TVM_CLI_VERSION)
  ACKI_CACHE_DIR    where to download tvm-cli and the ABI (default: ~/.cache/acki-nacki-scripts)
EOF
}

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
info() { printf '==> %s\n' "$*"; }

ask() { # ask PROMPT VAR: reads one line, trimming surrounding whitespace
    local ask_line
    printf '%s' "$1"
    IFS= read -r ask_line || die "input closed, no confirmation received"
    ask_line=${ask_line#"${ask_line%%[![:space:]]*}"}
    ask_line=${ask_line%"${ask_line##*[![:space:]]}"}
    printf -v "$2" '%s' "$ask_line"
}

# --- numbers: amounts are nano-unit strings, no bash arithmetic on them ---

to_nano() { # "1.5" -> 1500000000
    local v=${1/,/.} int frac
    [[ $v =~ ^([0-9]*)(\.([0-9]{0,9}))?$ ]] || return 1
    int=${BASH_REMATCH[1]}
    frac=${BASH_REMATCH[3]}000000000
    v=$int${frac:0:9}
    v=${v#"${v%%[!0]*}"}
    [[ -n $v ]] || return 1
    printf '%s\n' "$v"
}

fmt_nano() { # 1500000000 -> 1.5
    local n=${1:-0} int frac
    n=${n#"${n%%[!0]*}"}
    while ((${#n} < 10)); do n=0$n; done
    int=${n:0:${#n}-9}
    frac=${n:${#n}-9}
    while [[ $frac == *0 ]]; do frac=${frac%0}; done
    printf '%s%s\n' "$int" "${frac:+.$frac}"
}

num_ge() { # num_ge A B: A >= B for non-negative integers of any length
    local a=${1#"${1%%[!0]*}"} b=${2#"${2%%[!0]*}"}
    if ((${#a} != ${#b})); then
        ((${#a} > ${#b}))
        return
    fi
    [[ $a > $b || $a == "$b" ]]
}

num_add() { # num_add A B: A + B for non-negative integers of any length
    local a=$1 b=$2 sum= carry=0 x y d
    while [[ -n $a || -n $b ]] || ((carry)); do
        x=${a: -1} y=${b: -1}
        d=$((${x:-0} + ${y:-0} + carry))
        sum=$((d % 10))$sum
        carry=$((d / 10))
        a=${a%?} b=${b%?}
    done
    sum=${sum#"${sum%%[!0]*}"}
    printf '%s\n' "${sum:-0}"
}

# --- parsing tvm-cli -j output (it is always one key per line) ---

json_get() { # json_get KEY < json: the first "KEY": value
    sed -n -e "s/^ *\"$1\": *\"\(.*\)\",\{0,1\} *\$/\1/p" \
        -e "s/^ *\"$1\": *\([^\" ,]*\),\{0,1\} *\$/\1/p" | sed -n 1p
}

ecc_get() { # ecc_get ID < account json: ECC token balance in nano (0 if absent)
    local v
    v=$(sed -n -e '/"ecc_balance": {}/q' -e '/"ecc_balance": {/,/}/p' |
        sed -n "s/^ *\"$1\": *\"\{0,1\}\([0-9]*\)\"\{0,1\},\{0,1\} *\$/\1/p" | sed -n 1p)
    printf '%s\n' "${v:-0}"
}

# --- tvm-cli ---

cli() { "$TVM_CLI" -c "$CACHE_DIR/tvm-cli.conf.json" -u "$ENDPOINT" -j "$@"; }

cli_version() { "$1" version 2>/dev/null | sed -n 's/^tvm-cli \([0-9][0-9.]*\).*/\1/p' | sed -n 1p; }

version_ge() { # version_ge 3.0.10 3.0.6
    local IFS=. i
    local -a a=($1) b=($2)
    for ((i = 0; i < ${#b[@]}; i++)); do
        ((10#${a[i]:-0} > 10#${b[i]})) && return 0
        ((10#${a[i]:-0} < 10#${b[i]})) && return 1
    done
    return 0
}

usable_cli() { # is this tvm-cli recent enough
    local v
    v=$(cli_version "$1")
    [[ -n $v ]] && version_ge "$v" "$TVM_CLI_MIN"
}

ensure_tvm_cli() {
    if [[ -n ${TVM_CLI:-} ]]; then
        usable_cli "$TVM_CLI" || die "TVM_CLI=$TVM_CLI: tvm-cli $TVM_CLI_MIN or newer is required"
        return
    fi
    if command -v tvm-cli >/dev/null && usable_cli "$(command -v tvm-cli)"; then
        TVM_CLI=$(command -v tvm-cli)
        return
    fi
    local dir=$CACHE_DIR/tvm-cli-$TVM_CLI_VERSION
    TVM_CLI=$dir/tvm-cli
    [[ -x $TVM_CLI ]] && return

    local os arch asset tmp
    case $(uname -s) in
        Linux) os=linux-musl ;;
        Darwin) os=macos ;;
        *) die "unsupported OS $(uname -s): install tvm-cli yourself and set TVM_CLI" ;;
    esac
    case $(uname -m) in
        x86_64 | amd64) arch=amd64 ;;
        aarch64 | arm64) arch=arm64 ;;
        *) die "unsupported architecture $(uname -m): install tvm-cli yourself and set TVM_CLI" ;;
    esac
    [[ $os-$arch != macos-amd64 ]] || die "there is no prebuilt tvm-cli for macOS x86_64: install it yourself and set TVM_CLI"
    asset=tvm-cli-$TVM_CLI_VERSION-$os-$arch.tar.gz

    info "Downloading tvm-cli $TVM_CLI_VERSION ($os-$arch)"
    mkdir -p "$dir"
    tmp=$(mktemp -d "$dir/download.XXXXXX")
    curl -fsSL --retry 3 -o "$tmp/$asset" \
        "https://github.com/tvmlabs/tvm-sdk/releases/download/v$TVM_CLI_VERSION/$asset" ||
        { rm -rf "$tmp"; die "failed to download $asset"; }
    tar -xzf "$tmp/$asset" -C "$tmp" tvm-cli || { rm -rf "$tmp"; die "$asset does not contain tvm-cli"; }
    chmod 755 "$tmp/tvm-cli"
    mv "$tmp/tvm-cli" "$TVM_CLI"
    rm -rf "$tmp"
    usable_cli "$TVM_CLI" || die "the downloaded tvm-cli does not run: $TVM_CLI"
}

fetch() { # fetch URL FILE
    curl -fsSL --retry 3 -o "$2.part" "$1" || { rm -f "$2.part"; die "failed to download $1"; }
    mv "$2.part" "$2"
}

# Reads the account state into ACC_TYPE (NonExist if there is no account),
# ACC_BALANCE (VMSHELL), ACC_NACKL, ACC_SHELL (nano) and ACC_CODE_HASH. On a
# network error returns 1 and leaves the error text in ACC_ERROR.
fetch_account() {
    local out
    ACC_TYPE=NonExist ACC_BALANCE=0 ACC_NACKL=0 ACC_SHELL=0 ACC_CODE_HASH= ACC_ERROR=
    if ! out=$(cli account "$1" 2>&1); then
        [[ $out == *"Not found"* ]] && return 0
        ACC_TYPE=Unknown ACC_ERROR=$out
        return 1
    fi
    ACC_TYPE=$(json_get acc_type <<<"$out")
    ACC_BALANCE=$(json_get balance <<<"$out")
    ACC_CODE_HASH=$(json_get code_hash <<<"$out")
    ACC_NACKL=$(ecc_get 1 <<<"$out")
    ACC_SHELL=$(ecc_get 2 <<<"$out")
    : "${ACC_TYPE:=NonExist}" "${ACC_BALANCE:=0}"
}

check_address() { # check_address WHAT ADDRESS: strict DAPP_ID::ACCOUNT_ID form
    [[ $2 =~ ^[0-9a-f]{64}::[0-9a-f]{64}$ ]] && return
    if [[ $2 =~ ^-?[0-9]+:[0-9a-f]{64}$ || $2 =~ ^[0-9a-f]{64}$ ]]; then
        die "$1 $2 uses a legacy format: specify the address as DAPP_ID::ACCOUNT_ID"
    fi
    die "$1 $2: expected an address in the DAPP_ID::ACCOUNT_ID form (64 hex characters each)"
}

lower() { printf '%s' "$1" | tr 'A-F' 'a-f'; }

# --- main ---

need_arg() { (($# >= 2)) || die "$1: missing value"; }

args=()
while (($#)); do
    case $1 in
        -u | --url) need_arg "$@"; ENDPOINT=$2; shift 2 ;;
        -d | --dir) need_arg "$@"; WALLET_DIR=$2; shift 2 ;;
        -w | --wallet) need_arg "$@"; WALLET=$2; shift 2 ;;
        -k | --keys) need_arg "$@"; KEYS=$2; shift 2 ;;
        -y | --yes) ASSUME_YES=1; shift ;;
        -h | --help) usage; exit 0 ;;
        --) shift; args+=("$@"); break ;;
        -*) printf 'Unknown option: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
        *) args+=("$1"); shift ;;
    esac
done
((${#args[@]} == 2)) || { usage >&2; exit 2; }

DEST=$(lower "${args[0]}")
check_address "recipient" "$DEST"
AMOUNT=${args[1]}
AMOUNT_NANO=$(to_nano "$AMOUNT") ||
    die "invalid amount '$AMOUNT': a positive number with at most 9 decimal places is required"

if [[ -z $WALLET ]]; then
    [[ -s $WALLET_DIR/msig.addr ]] ||
        die "there is no wallet in $WALLET_DIR: deploy one with deploy-multisig.sh or pass --wallet and --keys"
    WALLET=$(sed -n 1p "$WALLET_DIR/msig.addr")
fi
WALLET=$(lower "$WALLET")
check_address "wallet" "$WALLET"
KEYS=${KEYS:-$WALLET_DIR/msig.keys.json}
[[ -s $KEYS ]] || die "key file $KEYS not found"
PUB=$(json_get public <"$KEYS")
[[ $PUB =~ ^[0-9a-fA-F]{64}$ ]] || die "$KEYS: no public key found"
[[ $DEST != "$WALLET" ]] || die "the recipient is the sending wallet itself"

mkdir -p "$CACHE_DIR"
ensure_tvm_cli
ABI=$WALLET_DIR/$MSIG.abi.json
if [[ ! -s $ABI ]]; then
    ABI=$CACHE_DIR/$MSIG.abi.json
    [[ -s $ABI ]] || { info "Downloading $MSIG.abi.json"; fetch "$MSIG_URL/$MSIG.abi.json" "$ABI"; }
fi
info "Network: $ENDPOINT, tvm-cli: $TVM_CLI"

# The wallet must be deployed, run the expected contract, and have our key as
# its only custodian (otherwise sendTransaction is rejected).
fetch_account "$WALLET" || die "failed to get the wallet state: $ACC_ERROR"
[[ $ACC_TYPE == Active ]] || die "wallet $WALLET is not deployed (state: $ACC_TYPE)"
[[ $ACC_CODE_HASH == "$MSIG_CODE_HASH" ]] ||
    die "$WALLET is not a $MSIG (code hash $ACC_CODE_HASH)"
WALLET_GAS=$ACC_BALANCE
WALLET_NACKL=$ACC_NACKL

out=$(cli run "$WALLET" getCustodians '{}' --abi "$ABI" 2>&1) || { printf '%s\n' "$out" >&2; die "failed to get the wallet custodians"; }
custodians=$(sed -n 's/^ *"owner_pubkey": *"0x0*\([0-9a-fA-F]*\)".*/\1/p' <<<"$out")
[[ -n $custodians ]] || { printf '%s\n' "$out" >&2; die "failed to parse the custodian list"; }
[[ $custodians != *$'\n'* ]] || die "the wallet has several custodians: this script supports single-custodian wallets only"
[[ $(lower "$custodians") == "$(lower "${PUB#"${PUB%%[!0]*}"}")" ]] ||
    die "key $KEYS is not a custodian of wallet $WALLET"

num_ge "$WALLET_NACKL" "$AMOUNT_NANO" ||
    die "the wallet holds $(fmt_nano "$WALLET_NACKL") NACKL, cannot send $(fmt_nano "$AMOUNT_NANO")"
num_ge "$WALLET_GAS" "$MIN_GAS" ||
    die "the wallet holds $(fmt_nano "$WALLET_GAS") VMSHELL, not enough for gas (at least $(fmt_nano "$MIN_GAS") is required). Top it up with SHELL converted to VMSHELL (flag 16)"

# The recipient. The transfer is addressed by account_id (dest = 0:ACCOUNT_ID),
# and a missing account is created in its own dapp (DAPP_ID == ACCOUNT_ID).
DEST_DAPP=${DEST%%::*}
DEST_ACC=${DEST##*::}
fetch_account "$DEST" || die "failed to get the recipient state: $ACC_ERROR"
case $ACC_TYPE in
    Active) BOUNCE=true ;;
    Uninit)
        BOUNCE=false
        echo "Warning: the recipient is not deployed yet (Uninit); the NACKL will stay on its address."
        ;;
    NonExist)
        [[ $DEST_DAPP == "$DEST_ACC" ]] ||
            die "account $DEST does not exist. Check the address: you can send to an existing account or to a new address of the form ID::ID"
        BOUNCE=false
        echo "Warning: account $DEST does not exist yet; the transfer will create it (Uninit)."
        ;;
    *) die "the recipient is $ACC_TYPE, the transfer is not possible" ;;
esac
DEST_NACKL_BEFORE=$ACC_NACKL

cat <<EOF

From:    $WALLET
         NACKL: $(fmt_nano "$WALLET_NACKL"), VMSHELL: $(fmt_nano "$WALLET_GAS")
To:      $DEST ($ACC_TYPE)
Amount:  $(fmt_nano "$AMOUNT_NANO") NACKL

EOF
if [[ -z $ASSUME_YES ]]; then
    ask "Send? Type yes: " reply
    if [[ $(printf '%s' "$reply" | tr '[:upper:]' '[:lower:]') != yes ]]; then
        echo "Transfer cancelled: expected 'yes', got '$reply'."
        exit 1
    fi
fi

params="{\"dest\":\"0:$DEST_ACC\",\"value\":0,\"cc\":{\"1\":\"$AMOUNT_NANO\"},\"bounce\":$BOUNCE,\"flags\":1,\"payload\":\"\",\"dapp_id\":\"0x$DEST_DAPP\"}"
info "Sending the transfer"
if ! out=$(cli call "$WALLET" sendTransaction "$params" --abi "$ABI" --sign "$KEYS" 2>&1); then
    printf '%s\n' "$out" >&2
    die "the transfer was not confirmed. The message may still have been delivered: check the wallet and recipient balances before retrying"
fi
info "Wallet transaction: $(json_get tx_hash <<<"$out")"

# Crediting the recipient is a separate transaction: wait for it up to a minute.
expected=$(num_add "$DEST_NACKL_BEFORE" "$AMOUNT_NANO")
for ((i = 0; i < 20; i++)); do
    fetch_account "$DEST" && num_ge "$ACC_NACKL" "$expected" && break
    sleep 3
done
if num_ge "$ACC_NACKL" "$expected"; then
    echo "Done: the recipient received $(fmt_nano "$AMOUNT_NANO") NACKL, its balance is $(fmt_nano "$ACC_NACKL") NACKL."
else
    echo "The transfer was sent, but the recipient has not received the NACKL within a minute (balance: $(fmt_nano "$ACC_NACKL"))."
    echo "Check the balance later and do not resend the transfer until you know the outcome."
    exit 1
fi
