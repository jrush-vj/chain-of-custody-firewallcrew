import React, { useEffect, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import './Navbar.css';

const links = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/accounts', label: 'Accounts' },
  { to: '/transactions', label: 'Transactions' },
  { to: '/transfer', label: 'Transfer' },
  { to: '/payments', label: 'Payments' },
  { to: '/bills', label: 'Orders & Bills' }
];

const Navbar = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  // Close the mobile menu whenever the route changes.
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <nav className="navbar" aria-label="Main">
      <div className="navbar-container">
        <Link to="/dashboard" className="navbar-brand">
          <span className="brand-mark">NB</span>
          <div>
            <span className="brand-title">NovaBank</span>
            <small>Witnessed Core Banking</small>
          </div>
        </Link>

        {user ? (
          <>
            <button
              type="button"
              className={`menu-toggle${menuOpen ? ' open' : ''}`}
              aria-expanded={menuOpen}
              aria-controls="navbar-menu"
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <span />
              <span />
              <span />
            </button>
            <div id="navbar-menu" className={`navbar-menu${menuOpen ? ' open' : ''}`}>
              <div className="navbar-links">
                {links.map((link) => (
                  <NavLink
                    key={link.to}
                    to={link.to}
                    className={({ isActive }) => `navbar-link${isActive ? ' active' : ''}`}
                  >
                    {link.label}
                  </NavLink>
                ))}
              </div>
              <div className="navbar-user">
                <div className="user-chip">
                  <span className="user-initial">{user.username?.charAt(0).toUpperCase()}</span>
                  <div>
                    <p>{user.username}</p>
                    <small>{user.email}</small>
                  </div>
                </div>
                <button onClick={handleLogout} className="logout-btn">
                  Logout
                </button>
              </div>
            </div>
          </>
        ) : (
          <Link to="/login" className="navbar-link">
            Sign in
          </Link>
        )}
      </div>
    </nav>
  );
};

export default Navbar;
