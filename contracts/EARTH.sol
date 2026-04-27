// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title EARTH - Rebase ERC20 with excluded addresses
/// @notice Holders' balances grow via rebase. Excluded addresses (pools, Reactor) do not rebase.
///         Reactor is the sole minter (via rebase). Anyone can burn their own tokens.
contract EARTH {
    string public constant name = "EARTH";
    string public constant symbol = "EARTH";
    uint8  public constant decimals = 18;

    // ── Rebase state ───────────────────────────────────────────────────────────
    uint256 private _rebaseIndex = 1e18;           // multiplier for non-excluded holders
    mapping(address => uint256) private _shares;   // internal accounting units
    uint256 private _totalNonExcludedShares;        // sum of shares held by rebasing wallets
    uint256 private _totalExcludedTokens;           // sum of raw token balances of excluded addresses

    // ── Exclusion ──────────────────────────────────────────────────────────────
    mapping(address => bool) public isExcluded;

    // ── Allowances (denominated in tokens, not shares) ─────────────────────────
    mapping(address => mapping(address => uint256)) private _allowances;

    // ── Reactor (one-time set, then locked forever) ────────────────────────────
    address public reactor;
    bool    private _reactorLocked;
    address private _deployer;

    // ── Events ─────────────────────────────────────────────────────────────────
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Rebase(uint256 newIndex, uint256 mintAmount);
    event Excluded(address indexed account);

    // ═══════════════════════════════════════════════════════════════════════════
    //  Constructor
    // ═══════════════════════════════════════════════════════════════════════════

    /// @param initialSupply Total tokens minted to deployer (in wei, e.g. 1e18 = 1 EARTH)
    constructor(uint256 initialSupply) {
        require(initialSupply > 0, "zero supply");
        _deployer = msg.sender;
        _shares[msg.sender] = initialSupply;       // 1 share = 1 token at launch
        _totalNonExcludedShares = initialSupply;
        emit Transfer(address(0), msg.sender, initialSupply);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  One-time Reactor setup
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Set the Reactor address. Can only be called once, by deployer.
    ///         Automatically excludes the Reactor from rebase and renounces deployer.
    function setReactor(address _reactor) external {
        require(msg.sender == _deployer, "not deployer");
        require(!_reactorLocked, "locked");
        require(_reactor != address(0), "zero address");

        reactor = _reactor;
        _reactorLocked = true;
        _deployer = address(0);

        // Reactor starts with 0 balance — just mark excluded
        isExcluded[_reactor] = true;
        emit Excluded(_reactor);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  ERC20 Views
    // ═══════════════════════════════════════════════════════════════════════════

    function totalSupply() external view returns (uint256) {
        return _totalExcludedTokens + (_totalNonExcludedShares * _rebaseIndex / 1e18);
    }

    function balanceOf(address account) public view returns (uint256) {
        if (isExcluded[account]) return _shares[account];
        return _shares[account] * _rebaseIndex / 1e18;
    }

    function allowance(address owner, address spender) external view returns (uint256) {
        return _allowances[owner][spender];
    }

    function rebaseIndex() external view returns (uint256) {
        return _rebaseIndex;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  ERC20 Mutators
    // ═══════════════════════════════════════════════════════════════════════════

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        _allowances[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 current = _allowances[from][msg.sender];
        if (current != type(uint256).max) {
            require(current >= amount, "allowance exceeded");
            unchecked { _allowances[from][msg.sender] = current - amount; }
        }
        _transfer(from, to, amount);
        return true;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Rebase — only Reactor can call
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Mint `mintAmount` new tokens distributed proportionally to all non-excluded holders.
    ///         Works by increasing the global rebase index — no iteration needed.
    function rebase(uint256 mintAmount) external {
        require(msg.sender == reactor, "not reactor");
        require(_totalNonExcludedShares > 0, "no holders");
        require(mintAmount > 0, "zero mint");
        _rebaseIndex += mintAmount * 1e18 / _totalNonExcludedShares;
        emit Rebase(_rebaseIndex, mintAmount);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Burn — anyone can burn their own tokens
    // ═══════════════════════════════════════════════════════════════════════════

    function burn(uint256 amount) external {
        require(amount > 0, "zero burn");
        if (isExcluded[msg.sender]) {
            require(_shares[msg.sender] >= amount, "exceeds balance");
            _shares[msg.sender] -= amount;
            _totalExcludedTokens -= amount;
        } else {
            uint256 sharesToBurn = _tokensToShares(amount);
            require(_shares[msg.sender] >= sharesToBurn, "exceeds balance");
            _shares[msg.sender] -= sharesToBurn;
            _totalNonExcludedShares -= sharesToBurn;
        }
        emit Transfer(msg.sender, address(0), amount);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Exclude — only Reactor can exclude addresses (pools)
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Exclude an address from rebase. Converts their shares to raw token balance.
    function excludeFromRebase(address account) external {
        require(msg.sender == reactor, "not reactor");
        require(!isExcluded[account], "already excluded");

        uint256 tokenBalance = balanceOf(account);
        uint256 currentShares = _shares[account];

        _totalNonExcludedShares -= currentShares;
        isExcluded[account] = true;
        _shares[account] = tokenBalance;
        _totalExcludedTokens += tokenBalance;

        emit Excluded(account);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Internal
    // ═══════════════════════════════════════════════════════════════════════════

    function _transfer(address from, address to, uint256 amount) internal {
        require(from != address(0) && to != address(0), "zero address");
        require(amount > 0, "zero amount");

        // Deduct from sender
        if (isExcluded[from]) {
            require(_shares[from] >= amount, "exceeds balance");
            _shares[from] -= amount;
            _totalExcludedTokens -= amount;
        } else {
            uint256 sharesToDeduct = _tokensToShares(amount);
            require(_shares[from] >= sharesToDeduct, "exceeds balance");
            _shares[from] -= sharesToDeduct;
            _totalNonExcludedShares -= sharesToDeduct;
        }

        // Credit to receiver
        if (isExcluded[to]) {
            _shares[to] += amount;
            _totalExcludedTokens += amount;
        } else {
            uint256 sharesToAdd = _tokensToShares(amount);
            _shares[to] += sharesToAdd;
            _totalNonExcludedShares += sharesToAdd;
        }

        emit Transfer(from, to, amount);
    }

    function _tokensToShares(uint256 amount) internal view returns (uint256) {
        return amount * 1e18 / _rebaseIndex;
    }
}
