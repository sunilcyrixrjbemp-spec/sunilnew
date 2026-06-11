import React, { useState } from 'react';
import './LoginPage.css';

export default function LoginPage() {
  const [userId, setUserId] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    // Simulate login for now
    setTimeout(() => {
      setLoading(false);
      alert('Login clicked. API not connected yet.');
    }, 1500);
  };

  return (
    <div className="login-container">
      <div className="login-card glassmorphism">
        <div className="header-text">
          <div className="logo-placeholder">CH</div>
          <h1>Cyrix Healthcare</h1>
          <p>Next-Gen Field Data Management</p>
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
            {loading ? <span className="spinner"></span> : "Secure Login"}
          </button>
          
          <div className="form-footer">
            <a href="#retrieve">Forgot User ID?</a>
            <span className="divider"></span>
            <a href="#reset">Need Help?</a>
          </div>
        </form>
      </div>
      
      {/* Background Decorative Elements */}
      <div className="bg-shape shape-1"></div>
      <div className="bg-shape shape-2"></div>
      <div className="bg-shape shape-3"></div>
    </div>
  );
}
