import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import './LoginPage.css';

interface PopupState {
  show: boolean;
  message: string;
}

export default function LoginPage() {
  const [userId, setUserId] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [popup, setPopup] = useState<PopupState>({ show: false, message: '' });
  
  const navigate = useNavigate();

  // Redirect to dashboard if already logged in
  useEffect(() => {
    if (localStorage.getItem('logged_in_user_id')) {
      navigate('/dashboard');
    }
  }, [navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, password })
      });

      const data = await response.json();

      if (response.ok && data.success) {
        localStorage.clear();
        localStorage.setItem('logged_in_user_id', data.user_id);
        localStorage.setItem('display_name', data.full_name);
        localStorage.setItem('user_role', data.role);
        navigate('/dashboard');
      } else {
        setPopup({ show: true, message: data.message || 'Login failed.' });
      }
    } catch (err) {
      setPopup({ show: true, message: 'Server Connection Failed. Please try again.' });
    } finally {
      setLoading(false);
    }
  };

  const closePopup = () => {
    setPopup({ show: false, message: '' });
  };

  return (
    <div className="login-container">
      {/* Custom Error Popup Overlay */}
      {popup.show && (
        <>
          <div className="popup-overlay" onClick={closePopup}></div>
          <div className="custom-popup">
            <div className="icon-wrapper error">
              <svg width="32" height="32" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </div>
            <h3 style={{ color: 'var(--primary-dark)', fontSize: '16px', marginBottom: '24px', fontWeight: 700, lineHeight: 1.4 }}>
              {popup.message}
            </h3>
            <button className="submit-btn" onClick={closePopup} style={{ margin: 0 }}>
              OK, Got it
            </button>
          </div>
        </>
      )}

      <div className="login-card">
        <div className="header-text">
          <img src="/logo.png" alt="Cyrix Logo" className="cyrix-img" />
          <h1>Cyrix Healthcare</h1>
          <p>Field Data Management</p>
        </div>

        <form onSubmit={handleSubmit} className="login-form">
          <div className="form-group">
            <label>User ID</label>
            <input 
              type="text" 
              placeholder="Enter your User ID" 
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              required 
              autoComplete="username"
            />
          </div>

          <div className="form-group">
            <label>Password</label>
            <div className="password-wrapper">
              <input 
                type={showPassword ? "text" : "password"} 
                placeholder="Enter your password" 
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required 
                autoComplete="current-password"
              />
              <button 
                type="button" 
                className="toggle-text-btn"
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
          </div>

          <button type="submit" className="submit-btn" disabled={loading}>
            {loading ? (
              <>
                <span className="spinner"></span>
                <span>Verifying...</span>
              </>
            ) : (
              "Login to Dashboard"
            )}
          </button>
          
          <div className="form-footer">
            <Link to="/retrieve">Get Your User ID</Link>
            <span className="divider">|</span>
            <Link to="/reset">Account Help</Link>
          </div>
        </form>

        <footer>
          <p>
            &copy; Designed & Developed by{' '}
            <a href="https://sunilbishnoi.co.in" target="_blank" rel="noopener noreferrer">
              Sunil Bishnoi
            </a>
          </p>
        </footer>
      </div>
    </div>
  );
}
