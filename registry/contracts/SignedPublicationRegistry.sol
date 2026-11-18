// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

contract SignedPublicationRegistry {
    error Unauthorized();
    error InvalidKey();
    error InvalidObservation();
    error KeyNotRegistered();
    error AlreadyRecorded();
    error NonceNotVerifiable();

    struct Observation {
        uint64 registeredAt;
        uint64 nonceBlockNumber;
        bytes32 nonceBlockHash;
        bytes32 documentHash;
        bytes32 evidenceHash;
        bytes32 keyFingerprint;
    }

    address public immutable writer;
    uint64 public immutable nonceChainId;

    mapping(bytes32 => mapping(bytes32 => uint64)) public keyRegisteredAt;
    mapping(bytes32 => Observation[]) private observations;
    mapping(bytes32 => mapping(bytes32 => uint64)) public firstSeen;
    mapping(bytes32 => uint64) public evidenceRegisteredAt;

    event KeyRegistered(bytes32 indexed authorityId, bytes32 indexed fingerprint, uint64 registeredAt,
        string authority, string keyId);
    event ObservationRecorded(bytes32 indexed sourceId, bytes32 indexed documentHash, bytes32 indexed evidenceHash,
        uint64 registeredAt, uint64 nonceBlockNumber, bytes32 nonceBlockHash, bytes32 keyFingerprint,
        uint256 index, string sourceURL);

    constructor(address authorizedWriter, uint64 nonceChain) {
        if (authorizedWriter == address(0) || nonceChain == 0) revert InvalidObservation();
        writer = authorizedWriter;
        nonceChainId = nonceChain;
    }

    function hashAlgorithm() external pure returns (string memory) { return "SHA-256"; }
    function signatureScheme() external pure returns (string memory) { return "RFC9421-ed25519"; }

    function registerKey(string calldata authority, string calldata keyId, bytes32 fingerprint) external {
        if (msg.sender != writer) revert Unauthorized();
        if (bytes(authority).length == 0 || bytes(authority).length > 253 || bytes(keyId).length == 0 ||
            bytes(keyId).length > 64 || fingerprint == bytes32(0)) revert InvalidKey();
        bytes32 authorityId = keccak256(bytes(authority));
        if (keyRegisteredAt[authorityId][fingerprint] != 0) revert AlreadyRecorded();
        keyRegisteredAt[authorityId][fingerprint] = uint64(block.timestamp);
        emit KeyRegistered(authorityId, fingerprint, uint64(block.timestamp), authority, keyId);
    }

    function recordObservation(string calldata sourceURL, bytes32 documentHash, bytes32 evidenceHash,
        uint64 nonceBlockNumber, bytes32 nonceBlockHash, bytes32 keyFingerprint) external returns (uint256 index)
    {
        if (msg.sender != writer) revert Unauthorized();
        if (bytes(sourceURL).length == 0 || bytes(sourceURL).length > 256 || documentHash == bytes32(0) ||
            evidenceHash == bytes32(0) || nonceBlockNumber == 0 || nonceBlockHash == bytes32(0))
            revert InvalidObservation();
        if (evidenceRegisteredAt[evidenceHash] != 0) revert AlreadyRecorded();
        requireNonce(nonceBlockNumber, nonceBlockHash);
        requireKey(sourceURL, keyFingerprint);
        Observation memory o = Observation(uint64(block.timestamp), nonceBlockNumber, nonceBlockHash, documentHash,
            evidenceHash, keyFingerprint);
        index = store(keccak256(bytes(sourceURL)), o);
        emitObservation(keccak256(bytes(sourceURL)), o, index, sourceURL);
    }

    function requireNonce(uint64 nonceBlockNumber, bytes32 nonceBlockHash) private view {
        if (nonceChainId != block.chainid) return;
        if (nonceBlockNumber >= block.number || block.number - nonceBlockNumber > 256 ||
            blockhash(nonceBlockNumber) != nonceBlockHash) revert NonceNotVerifiable();
    }

    function requireKey(string calldata sourceURL, bytes32 fingerprint) private view {
        uint64 keyTime = keyRegisteredAt[keccak256(authorityOf(bytes(sourceURL)))][fingerprint];
        if (keyTime == 0 || keyTime > block.timestamp) revert KeyNotRegistered();
    }

    function store(bytes32 sourceId, Observation memory o) private returns (uint256) {
        observations[sourceId].push(o);
        evidenceRegisteredAt[o.evidenceHash] = o.registeredAt;
        if (firstSeen[sourceId][o.documentHash] == 0) firstSeen[sourceId][o.documentHash] = o.registeredAt;
        return observations[sourceId].length - 1;
    }

    function emitObservation(bytes32 sourceId, Observation memory o, uint256 index, string calldata sourceURL) private {
        emit ObservationRecorded(sourceId, o.documentHash, o.evidenceHash, o.registeredAt, o.nonceBlockNumber,
            o.nonceBlockHash, o.keyFingerprint, index, sourceURL);
    }

    function observationCount(bytes32 sourceId) external view returns (uint256) {
        return observations[sourceId].length;
    }

    function observationAt(bytes32 sourceId, uint256 index) external view returns (Observation memory) {
        return observations[sourceId][index];
    }

    function authorityOf(bytes memory url) public pure returns (bytes memory authority) {
        bytes memory prefix = "https://";
        if (url.length <= prefix.length) revert InvalidObservation();
        for (uint256 i = 0; i < prefix.length; i++) if (url[i] != prefix[i]) revert InvalidObservation();
        uint256 end = prefix.length;
        while (end < url.length && url[end] != "/" && url[end] != "?" && url[end] != "#") end++;
        if (end == prefix.length || end == url.length || url[end] != "/") revert InvalidObservation();
        authority = new bytes(end - prefix.length);
        for (uint256 i = 0; i < authority.length; i++) {
            bytes1 c = url[prefix.length + i];
            if (c >= "A" && c <= "Z") revert InvalidObservation();
            authority[i] = c;
        }
    }
}
