#!/usr/bin/env bash
#
# Deploys a single-custodian Acki Nacki multisig wallet
# (UpdateCustodianMultisigWallet_v2).
#
# Flow: download tvm-cli and the contract if needed -> generate keys and
# compute the address -> ask the user to top the address up and wait for
# confirmation -> check the balance -> deploy -> verify the result.
#
# Keys and the seed phrase are saved to the wallet directory (mode 600).
# Re-running with the same directory resumes where it stopped: keys are reused
# (if they are missing but the seed phrase is there, they are restored from
# it), and an already deployed wallet is just reported.
#
# Dependencies: bash, curl, tar, sed (tvm-cli and the contract are downloaded).

set -euo pipefail
umask 077

TVM_CLI_VERSION=${TVM_CLI_VERSION:-3.0.6.an}
TVM_CLI_MIN=3.0.6
MSIG=UpdateCustodianMultisigWallet_v2
MSIG_URL=https://raw.githubusercontent.com/ackinacki/ackinacki/df524923ef1d2892bf93d239914e94276826d196/contracts/0.81.0_compiled/updatecustodianmultisigwallet_v2
MSIG_CODE_HASH=cfcaac10d43c8dc062298cb48df097be67cddec52b9cfd558309a7549f01c1f1
CACHE_DIR=${ACKI_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/acki-nacki-scripts}

ENDPOINT=${ACKI_ENDPOINT:-mainnet.ackinacki.org}
WALLET_DIR=./msig-wallet
MIN_BALANCE=0.5

usage() {
    cat <<EOF
Usage: $(basename "$0") [-u ENDPOINT] [-d DIR] [-m VMSHELL]

Deploys a single-custodian multisig wallet. During the deployment the script
shows the address to top up and waits for your confirmation.

  -u, --url ENDPOINT      network (default: \$ACKI_ENDPOINT or mainnet.ackinacki.org)
  -d, --dir DIR           wallet directory: keys, seed phrase, address, ABI and TVC
                          (default: ./msig-wallet)
  -m, --min-balance N     VMSHELL that must arrive at the address before deploying
                          (default: $MIN_BALANCE)
  -h, --help              show this help

Environment:
  TVM_CLI           path to tvm-cli (otherwise taken from PATH or downloaded)
  TVM_CLI_VERSION   tvm-cli version to download (default: $TVM_CLI_VERSION)
  ACKI_CACHE_DIR    where to download tvm-cli (default: ~/.cache/acki-nacki-scripts)
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

ensure_contract() {
    [[ -s $ABI ]] || { info "Downloading $MSIG.abi.json"; fetch "$MSIG_URL/$MSIG.abi.json" "$ABI"; }
    [[ -s $TVC ]] || { info "Downloading $MSIG.tvc"; fetch "$MSIG_URL/$MSIG.tvc" "$TVC"; }
    local hash
    hash=$(cli decode stateinit --tvc "$TVC" | json_get code_hash) || true
    [[ $hash == "$MSIG_CODE_HASH" ]] ||
        die "$TVC: code hash ${hash:-unreadable}, expected $MSIG_CODE_HASH. Delete the file and it will be downloaded again"
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

# --- main ---

need_arg() { (($# >= 2)) || die "$1: missing value"; }

while (($#)); do
    case $1 in
        -u | --url) need_arg "$@"; ENDPOINT=$2; shift 2 ;;
        -d | --dir) need_arg "$@"; WALLET_DIR=$2; shift 2 ;;
        -m | --min-balance) need_arg "$@"; MIN_BALANCE=$2; shift 2 ;;
        -h | --help) usage; exit 0 ;;
        *) printf 'Unknown option: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
    esac
done
MIN_BALANCE_NANO=$(to_nano "$MIN_BALANCE") || die "invalid --min-balance value: $MIN_BALANCE"

mkdir -p "$WALLET_DIR" "$CACHE_DIR"
WALLET_DIR=$(cd "$WALLET_DIR" && pwd)
ABI=$WALLET_DIR/$MSIG.abi.json
TVC=$WALLET_DIR/$MSIG.tvc
KEYS=$WALLET_DIR/msig.keys.json
SEED=$WALLET_DIR/msig.seed
ADDR_FILE=$WALLET_DIR/msig.addr

ensure_tvm_cli
ensure_contract
info "Network: $ENDPOINT, tvm-cli: $TVM_CLI"

# A seed phrase without keys: restore the keys from the phrase instead of
# generating new ones, otherwise the phrase would no longer match the wallet.
if [[ ! -s $KEYS && -e $SEED ]]; then
    info "No keys found, deriving them from the seed phrase in $SEED"
    rm -f "$KEYS.part"
    # tvm-cli takes the phrase only as a command-line argument, so it is
    # visible in this machine's process list while the command runs.
    # The tvm-cli error is not printed: it may contain the start of the phrase.
    if ! cli getkeypair -o "$KEYS.part" -p "$(<"$SEED")" >/dev/null 2>&1 ||
        [[ -z $(json_get public <"$KEYS.part" 2>/dev/null) ]]; then
        rm -f "$KEYS.part"
        die "failed to derive keys from the seed phrase in $SEED: the phrase is empty or corrupted"
    fi
    chmod 600 "$KEYS.part"
    mv "$KEYS.part" "$KEYS"
fi

# genaddr --save writes the public key into the TVC: without it the deploy
# would go to a different address.
if [[ -s $KEYS ]]; then
    info "Using keys from $KEYS"
    [[ -s $SEED ]] || echo "Warning: there is no seed phrase file $SEED; make sure you have a backup of the phrase."
    gen=$(cli genaddr --abi "$ABI" --setkey "$KEYS" --save "$TVC" 2>&1) || die "genaddr: $gen"
else
    info "Generating custodian keys"
    gen=$(cli genaddr --abi "$ABI" --genkey "$KEYS" --save "$TVC" 2>&1) || die "genaddr: $gen"
    seed=$(json_get seed_phrase <<<"$gen")
    # Never leave keys without a saved seed phrase: on failure remove them so
    # that the next run generates everything again.
    if [[ -z $seed ]] || ! { rm -f "$SEED.part" && printf '%s\n' "$seed" >"$SEED.part" &&
        chmod 600 "$SEED.part" && mv "$SEED.part" "$SEED"; }; then
        rm -f "$SEED.part" 2>/dev/null || true
        rm -f "$KEYS" || die "failed to save the seed phrase to $SEED and to remove the keys: delete $KEYS manually"
        die "failed to save the seed phrase to $SEED; the keys were removed, run the script again"
    fi
    cat <<EOF

=============================== SEED PHRASE ===============================
$seed
===========================================================================
The seed phrase is saved to $SEED, the keys to $KEYS
(readable by the owner only). Make an offline backup of the phrase and never
send or show it to anyone: it gives full access to the wallet.

EOF
    unset seed
fi
ADDR=$(json_get dapp_account <<<"$gen")
unset gen
[[ $ADDR =~ ^[0-9a-f]{64}::[0-9a-f]{64}$ ]] || die "failed to compute the wallet address"
ID=${ADDR%%::*}
printf '%s\n' "$ADDR" >"$ADDR_FILE"
PUB=$(json_get public <"$KEYS")
[[ $PUB =~ ^[0-9a-f]{64}$ ]] || die "$KEYS: no public key found"

funded() { # is the account ready to deploy (or already deployed)
    [[ $ACC_TYPE == Active ]] ||
        { [[ $ACC_TYPE == Uninit ]] && num_ge "$ACC_BALANCE" "$MIN_BALANCE_NANO"; }
}

check_deployable() {
    case $ACC_TYPE in
        NonExist | Uninit | Active | Unknown) ;;
        *) die "account $ADDR is $ACC_TYPE, the wallet cannot be deployed" ;;
    esac
}

explain_balance() {
    case $ACC_TYPE in
        Unknown)
            printf '%s\n' "$ACC_ERROR" >&2
            echo "Failed to get the account state, please try again."
            ;;
        NonExist) echo "The transfer has not arrived yet." ;;
        Uninit)
            echo "The address holds $(fmt_nano "$ACC_BALANCE") VMSHELL, at least $MIN_BALANCE is required."
            if [[ $ACC_SHELL != 0 ]]; then
                echo "$(fmt_nano "$ACC_SHELL") SHELL arrived unconverted and cannot pay for gas."
                echo "Send SHELL again, converted to VMSHELL (flag 16)."
            fi
            ;;
    esac
}

fetch_account "$ADDR" || die "failed to get the state of account $ADDR: $ACC_ERROR"
check_deployable
if ! funded; then
    cat <<EOF

Wallet address:          $ADDR
Transfer destination:    0:$ID  (dapp_id: $ID)

Top up this address: send at least $MIN_BALANCE SHELL converted to VMSHELL
(flag 16). VMSHELL pays for gas: the deployment costs about 0.16, the rest is
kept for the fees of future transfers. Unconverted SHELL cannot pay for gas.
NACKL can be sent to this address after the deployment.

EOF
    while :; do
        ask "Press Enter once the transfer is sent (q to quit): " reply
        if [[ $reply == q || $reply == Q ]]; then
            echo "The keys, seed phrase and address are saved in $WALLET_DIR."
            echo "To continue, run the script again with the same directory (-d)."
            exit 0
        fi
        # A transfer takes a few seconds to arrive: wait for it up to 30 seconds.
        info "Checking the balance"
        for ((i = 0; i < 10; i++)); do
            fetch_account "$ADDR" || true
            check_deployable
            funded && break
            sleep 3
        done
        funded && break
        explain_balance
    done
fi

if [[ $ACC_TYPE == Uninit ]]; then
    info "Balance is $(fmt_nano "$ACC_BALANCE") VMSHELL, deploying the wallet"
    params="{\"owners_pubkey\":[\"0x$PUB\"],\"owners_address\":[],\"reqConfirms\":1,\"reqConfirmsData\":1,\"value\":0,\"minBalance\":0,\"targetBalance\":0}"
    if ! out=$(cli deploy --abi "$ABI" --sign "$KEYS" "$TVC" "$params" 2>&1); then
        printf '%s\n' "$out" >&2
        die "the deployment failed. Run the script again with the same directory: it will start from the balance check"
    fi
    for ((i = 0; i < 10; i++)); do
        fetch_account "$ADDR" && [[ $ACC_TYPE == Active ]] && break
        sleep 3
    done
else
    info "The wallet is already deployed"
fi

[[ $ACC_TYPE == Active ]] ||
    die "the wallet did not become active (state: $ACC_TYPE). Run the script again with the same directory"
[[ $ACC_CODE_HASH == "$MSIG_CODE_HASH" ]] ||
    die "a different code is deployed at $ADDR ($ACC_CODE_HASH)"

seed_note="$SEED (keep it secret)"
[[ -s $SEED ]] || seed_note="no file; keep your own backup of the phrase"

cat <<EOF

The wallet is deployed.
  Address:  $ADDR
  VMSHELL:  $(fmt_nano "$ACC_BALANCE")
  NACKL:    $(fmt_nano "$ACC_NACKL")
  Keys:     $KEYS (keep them secret)
  Phrase:   $seed_note

To transfer NACKL:
  ./send-nackl.sh -u $ENDPOINT -d "$WALLET_DIR" <DAPP_ID::ACCOUNT_ID> <AMOUNT>
EOF
