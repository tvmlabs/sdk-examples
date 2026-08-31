pragma tvm-solidity >=0.76.1;
pragma AbiHeader expire;
pragma AbiHeader pubkey;

interface IHelloWorld {
    function touch() external;
}

contract helloWorld {
    uint32 public timestamp;

    constructor(uint64 value) {
        gosh.cnvrtshellq(value);
        require(tvm.pubkey() != 0, 101);
        tvm.accept();
        timestamp = block.timestamp;
    }

    function exchangeToken(uint64 value) public pure {
        tvm.accept();
        getTokens();
        gosh.cnvrtshellq(value);
    }

    function renderHelloWorld() public pure returns (string) {
        return 'helloWorld';
    }

    function touch() external {
        tvm.accept();
        getTokens();
        timestamp = block.timestamp;
    }

    function callExtTouch(address addr) public view {
        require(msg.pubkey() == tvm.pubkey(), 102);
        tvm.accept();
        getTokens();
        IHelloWorld(addr).touch();
    }

    function sendVMShell(address dest, uint128 amount, bool bounce) public view {
        require(msg.pubkey() == tvm.pubkey(), 102);
        tvm.accept();
        getTokens();
        dest.transfer(varuint16(amount), bounce, 0);
    }

    function sendShell(address dest, uint128 value) public view {
        require(msg.pubkey() == tvm.pubkey(), 102);
        tvm.accept();
        getTokens();

        TvmCell payload;
        mapping(uint32 => varuint32) cc;
        cc[2] = varuint32(value);
        dest.transfer(0, true, 1, payload, cc);
    }

    function sendTransaction(
        address dest,
        uint128 value,
        mapping(uint32 => varuint32) cc,
        bool bounce,
        uint8 flags,
        TvmCell payload
    ) public view {
        require(msg.pubkey() == tvm.pubkey(), 102);
        tvm.accept();
        dest.transfer(varuint16(value), bounce, flags, payload, cc);
    }

    function deployNewContract(
        TvmCell stateInit,
        uint128 initialBalance,
        TvmCell payload
    ) public view {
        require(msg.pubkey() == tvm.pubkey(), 102);
        tvm.accept();
        getTokens();
        address addr = address.makeAddrStd(0, tvm.hash(stateInit));
        addr.transfer({stateInit: stateInit, body: payload, value: varuint16(initialBalance)});
    }

    function getTokens() private pure {
        if (address(this).balance > 100000000000) {
            return;
        }
        gosh.mintshellq(100000000000);
    }
}
