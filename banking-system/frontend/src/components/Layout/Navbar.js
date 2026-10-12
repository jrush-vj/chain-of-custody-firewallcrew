import React from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import './Navbar.css';

const Navbar = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const links = [
    { to: '/dashboard', label: 'Dashboard' },
    { to: '/accounts', label: 'Accounts' },
    { to: '/transactions', label: 'Transactions' },
    { to: '/transfer', label: 'Transfer' },
    { to: '/payments', label: 'Payments' },
    { to: '/bills', label: 'Orders & Bills' }
  ];

  const isActive = (path) => location.pathname.startsWith(path);

  return (
    <nav className="navbar">
      <div className="navbar-container">
        <Link to="/dashboard" className="navbar-brand">
          <span className="brand-mark">NB</span>
          <div>
            <span className="brand-title">NovaBank</span>
            <small>Secure Core Banking</small>
          </div>
        </Link>

        {user ? (
          <div className="navbar-menu">
            <div className="navbar-links">
              {links.map((link) => (
                <Link
                  key={link.to}
                  to={link.to}
                  className={`navbar-link ${isActive(link.to) ? 'active' : ''}`}
                >
                  {link.label}
                </Link>
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
