// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice First inclusion time for SHA-256 document digests submitted by one writer.
/// @dev This records a digest, not authorship, document validity, or file contents.
contract DocumentRegistry {
    error Unauthorized();
    error InvalidWriter();
    error InvalidDigest();

    address public immutable writer;
    mapping(bytes32 => uint256) public registeredAt;

    event DocumentRegistered(bytes32 indexed sha256Digest, uint256 timestamp);

    constructor(address authorizedWriter) {
        if (authorizedWriter == address(0)) revert InvalidWriter();
        writer = authorizedWriter;
    }

    /// @notice Algorithm for the exact original file bytes: no text conversion or normalization.
    /// @dev SHA-256 produces 32 bytes; submit those bytes, not a hash of the hex string.
    function hashAlgorithm() external pure returns (string memory) {
        return "SHA-256";
    }

    /// @notice Anyone can read a digest without signing a transaction.
    /// @return exists Whether this digest has a registration.
    /// @return timestamp First inclusion time, Unix seconds; zero if absent.
    function getRecord(bytes32 sha256Digest) external view returns (bool exists, uint256 timestamp) {
        timestamp = registeredAt[sha256Digest];
        exists = timestamp != 0;
    }

    /// @notice Idempotent: repeat submissions retain the original timestamp.
    function register(bytes32 sha256Digest) external returns (uint256 timestamp) {
        if (msg.sender != writer) revert Unauthorized();
        if (sha256Digest == bytes32(0)) revert InvalidDigest();
        timestamp = registeredAt[sha256Digest];
        if (timestamp == 0) {
            timestamp = block.timestamp;
            registeredAt[sha256Digest] = timestamp;
            emit DocumentRegistered(sha256Digest, timestamp);
        }
    }
}
