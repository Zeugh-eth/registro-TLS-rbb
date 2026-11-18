// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice First on-chain registration of an attested PDF at an official URL/edition date.
/// @dev Trusts the configured application verifier to validate TLSNotary and the publication policy.
///      Does not itself fetch HTTPS, verify TLSNotary, or prove availability before observedAt.
contract PublicationRegistry {
    error Unauthorized();
    error InvalidClaim();
    error InvalidSignature();
    error ExpiredClaim();
    error AlreadyUsed();

    address public writer;
    address public verifier;
    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant CLAIM_TYPEHASH = keccak256("Publication(bytes32 sourceId,bytes32 documentHash,bytes32 evidenceHash,uint32 editionDate,uint32 publicationDate,uint64 observedAt,uint64 validUntil,bytes32 nonce)");
    uint256 private constant HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    struct Publication {
        bytes32 sourceId;
        bytes32 documentHash;
        bytes32 evidenceHash;
        uint32 editionDate; // YYYYMMDD: availability date declared by the official edition.
        uint32 publicationDate; // YYYYMMDD: publication date declared by the PDF.
        uint64 observedAt; // Verified session start, Unix seconds, subject to notary clock trust.
        uint64 validUntil;
        bytes32 nonce;
    }
    struct Record {
        uint64 registeredAt; // First block timestamp for this record, never overwritten.
        uint64 observedAt;
        uint32 publicationDate;
        bytes32 documentHash;
        bytes32 evidenceHash;
    }
    mapping(bytes32 => mapping(uint32 => Record)) private firstRecords;
    mapping(bytes32 => mapping(uint32 => mapping(bytes32 => Record))) private versions;
    mapping(bytes32 => uint64) public firstDigestRegisteredAt;
    mapping(bytes32 => bool) public usedNonces;
    mapping(uint32 => string[]) private dateSources;

    event PublicationRecorded(bytes32 indexed sourceId, uint32 indexed editionDate,
        bytes32 indexed documentHash, uint64 registeredAt, uint64 observedAt,
        uint32 publicationDate, bytes32 evidenceHash, string sourceURL);
    event PublicationObserved(bytes32 indexed sourceId, uint32 indexed editionDate,
        bytes32 indexed documentHash, uint64 observedAt, bytes32 evidenceHash);

    constructor(address authorizedWriter, address trustedVerifier) {
        if (authorizedWriter == address(0) || trustedVerifier == address(0)) revert InvalidClaim();
        writer = authorizedWriter;
        verifier = trustedVerifier;
    }

    function hashAlgorithm() external pure returns (string memory) { return "SHA-256"; }
    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("RBBPublicationRegistry"),
            keccak256("1"), block.chainid, address(this)));
    }
    function claimDigest(Publication calldata p) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), keccak256(abi.encode(
            CLAIM_TYPEHASH, p.sourceId, p.documentHash, p.evidenceHash, p.editionDate,
            p.publicationDate, p.observedAt, p.validUntil, p.nonce))));
    }

    /// @notice Repeated content never replaces the first timestamp; changed bytes get a new version.
    function registerPublication(string calldata sourceURL, Publication calldata p, bytes calldata signature)
        external returns (uint64 firstRegisteredAt)
    {
        if (msg.sender != writer) revert Unauthorized();
        if (bytes(sourceURL).length == 0 || bytes(sourceURL).length > 256 ||
            keccak256(bytes(sourceURL)) != p.sourceId || p.documentHash == bytes32(0) ||
            p.evidenceHash == bytes32(0) || p.nonce == bytes32(0) ||
            !validDate(p.editionDate) || !validDate(p.publicationDate) || p.observedAt == 0)
            revert InvalidClaim();
        if (block.timestamp > p.validUntil || p.validUntil > block.timestamp + 1 days ||
            p.observedAt > block.timestamp + 60 || block.timestamp > p.observedAt + 1 days)
            revert ExpiredClaim();
        if (usedNonces[p.nonce]) revert AlreadyUsed();
        if (signature.length != 65) revert InvalidSignature();
        {
        bytes32 r; bytes32 s; uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > HALF_ORDER || (v != 27 && v != 28) ||
            ecrecover(claimDigest(p), v, r, s) != verifier) revert InvalidSignature();
        }
        usedNonces[p.nonce] = true;
        Record memory record = Record(uint64(block.timestamp), p.observedAt,
            p.publicationDate, p.documentHash, p.evidenceHash);
        Record storage version = versions[p.sourceId][p.editionDate][p.documentHash];
        if (version.registeredAt == 0) {
            versions[p.sourceId][p.editionDate][p.documentHash] = record;
            emit PublicationRecorded(p.sourceId, p.editionDate, p.documentHash, record.registeredAt,
                p.observedAt, p.publicationDate, p.evidenceHash, sourceURL);
        }
        if (firstRecords[p.sourceId][p.editionDate].registeredAt == 0) {
            firstRecords[p.sourceId][p.editionDate] = record;
            dateSources[p.editionDate].push(sourceURL);
        }
        if (firstDigestRegisteredAt[p.documentHash] == 0) {
            firstDigestRegisteredAt[p.documentHash] = uint64(block.timestamp);
        }
        emit PublicationObserved(p.sourceId, p.editionDate, p.documentHash, p.observedAt, p.evidenceHash);
        return firstRecords[p.sourceId][p.editionDate].registeredAt;
    }

    function getRecord(bytes32 sourceId, uint32 editionDate) external view returns (bool exists, Record memory record) {
        record = firstRecords[sourceId][editionDate];
        exists = record.registeredAt != 0;
    }
    function getVersion(bytes32 sourceId, uint32 editionDate, bytes32 documentHash)
        external view returns (bool exists, Record memory record)
    {
        record = versions[sourceId][editionDate][documentHash];
        exists = record.registeredAt != 0;
    }
    function sourceCount(uint32 editionDate) external view returns (uint256) { return dateSources[editionDate].length; }
    function sourceAt(uint32 editionDate, uint256 index) external view returns (string memory) { return dateSources[editionDate][index]; }

    function validDate(uint32 date) private pure returns (bool) {
        uint32 year = date / 10000;
        uint32 month = date / 100 % 100;
        uint32 day = date % 100;
        if (year < 1995 || year > 9999 || month == 0 || month > 12 || day == 0) return false;
        uint32 daysInMonth = 31;
        if (month == 4 || month == 6 || month == 9 || month == 11) daysInMonth = 30;
        if (month == 2) daysInMonth = (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)) ? 29 : 28;
        return day <= daysInMonth;
    }
}
