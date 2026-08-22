import React from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';

export default function Layout() {
  const navigate = useNavigate();
  const user = JSON.parse(localStorage.getItem('afrikoba_user') || '{}');

  const logout = () => {
    localStorage.removeItem('afrikoba_token');
    localStorage.removeItem('afrikoba_user');
    navigate('/login');
  };

  const isAdmin = user.role === 'ADMIN';

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <h1>AFRIKOBA GLOBAL</h1>
          <p>Digital Banking & Upatu</p>
        </div>
        <nav className="nav">
          <NavLink to="/" end>DahShabari</NavLink>
          <NavLink to="/wallet">Wallet</NavLink>
          <NavLink to="/services">Huduma Zangu</NavLink>
          <NavLink to="/promotions">Matangazo</NavLink>
          <NavLink to="/vicoba">VICOBA</NavLink>
          <NavLink to="/rosca">Upatu (ROSCA)</NavLink>
          <NavLink to="/p2p">Uwekezaji (P2P)</NavLink>
          <NavLink to="/referrals">Referrals</NavLink>
          <NavLink to="/notifications">Arifa</NavLink>
          {isAdmin && <NavLink to="/admin">Utawala</NavLink>}
          <NavLink to="/settings">Mipangilio</NavLink>
        </nav>
        <div className="sidebar-user">
          <strong>{user.full_name}</strong>
          <div className="roles-tag">{user.role}</div>
          <div className="logout" onClick={logout}>Ondoka (Logout)</div>
        </div>
      </aside>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
