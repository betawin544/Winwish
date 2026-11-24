import { Component, OnInit, OnDestroy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ActivatedRoute } from '@angular/router';
import { AuthService } from '../../../core/services/auth.service';

@Component({
  selector: 'app-auth-landing',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="auth-landing-wrapper">
      <div class="glow-backdrop"></div>
      
      <!-- LOADING MODAL (IMAGE 1) -->
      <div *ngIf="isLoading" class="loading-modal-card glass-card" [class.fade-out]="isFadingOut">
        <div class="aviator-brand">
          <img class="site-logo-image" src="/assets/icons/winbet-mark.png" alt="Winbet" />
        </div>

        <!-- PROGRESS BAR CAPSULE -->
        <div class="progress-bar-container">
          <div class="progress-bar-fill" [style.width.%]="loadingProgress"></div>
        </div>

        <div class="progress-percent-text">{{ loadingProgress }}%</div>
        <div class="loading-status-text">Loading game.</div>

        <!-- SPEED UP CIRCLE BUTTON -->
        <button class="speedup-circle-btn" (click)="speedUpLoading()" type="button" title="Tap to speed up loading">
          <span class="speedup-text">WINBET</span>
        </button>

        <div class="speedup-hint-text">Tap the badge to speed up loading</div>
      </div>

      <!-- LOG IN / REGISTER / FORGOT OTP MODAL (IMAGE 2) -->
      <div *ngIf="!isLoading" class="auth-modal-card glass-card fade-in">
        <img class="site-logo-image auth-site-logo" src="/assets/icons/winbet-mark.png" alt="Winbet" />
        <h2 class="auth-title">
          {{ activeTab === 'login' ? 'Log In' : (activeTab === 'register' ? 'Register' : 'Reset Password') }}
        </h2>

        <!-- ERROR & SUCCESS MESSAGES -->
        <div *ngIf="errorMessage" class="alert-box error">
          <span>⚠️ {{ errorMessage }}</span>
        </div>
        <div *ngIf="successMessage" class="alert-box success">
          <span>✅ {{ successMessage }}</span>
        </div>

        <!-- LOGIN / REGISTER FORM -->
        <form *ngIf="activeTab !== 'forgot'" (ngSubmit)="onSubmit()" class="auth-form">
          <!-- COUNTRY SELECTOR -->
          <div class="form-group">
            <div class="select-wrapper">
              <select [(ngModel)]="selectedCountry" name="country" class="country-select">
                <option value="+254">Kenya (+254)</option>
                <option value="+255">Tanzania (+255)</option>
                <option value="+256">Uganda (+256)</option>
                <option value="+234">Nigeria (+234)</option>
                <option value="+27">South Africa (+27)</option>
              </select>
              <span class="select-arrow">▼</span>
            </div>
          </div>

          <!-- PHONE NUMBER INPUT ROW -->
          <div class="form-group">
            <div class="phone-input-row">
              <div class="country-code-box">{{ selectedCountry }}</div>
              <input 
                type="text" 
                [(ngModel)]="phone" 
                name="phone" 
                class="phone-input" 
                placeholder="Phone Number (9 digits)" 
                required 
              />
            </div>
            <div class="field-hint">Enter your phone number in local format without country code</div>
          </div>

          <!-- PASSWORD FIELD WITH SHOW/HIDE TOGGLE -->
          <div class="form-group margin-top-sm">
            <div class="password-input-wrapper">
              <input 
                [type]="showPassword ? 'text' : 'password'" 
                [(ngModel)]="password" 
                name="password" 
                class="password-input" 
                placeholder="Password" 
                required 
              />
              <button type="button" class="password-toggle-btn" (click)="toggleShowPassword()">
                {{ showPassword ? 'HIDE' : 'SHOW' }}
              </button>
            </div>
          </div>

          <!-- CONFIRM PASSWORD FIELD (ONLY IN REGISTER MODE) -->
          <div *ngIf="activeTab === 'register'" class="form-group margin-top-sm">
            <div class="password-input-wrapper">
              <input 
                [type]="showPassword ? 'text' : 'password'" 
                [(ngModel)]="confirmPassword" 
                name="confirmPassword" 
                class="password-input" 
                placeholder="Confirm Password" 
                required 
              />
            </div>
          </div>


          <!-- SUBMIT BUTTON -->
          <button
            type="submit"
            class="auth-submit-btn"
            [class.register-mode]="activeTab === 'register'"
            [disabled]="isSubmitting"
          >
            <span>{{ isSubmitting ? 'PLEASE WAIT...' : (activeTab === 'login' ? 'LOG IN' : 'CREATE ACCOUNT') }}</span>
            <span class="auth-submit-arrow" aria-hidden="true">→</span>
          </button>

          <!-- LINKS FOOTER -->
          <div class="auth-links-footer">
            <div *ngIf="activeTab === 'login'" class="link-row">
              <button type="button" class="auth-switch-btn" (click)="setTab('register')">
                <span>New to Winbet?</span>
                <span class="auth-switch-action">Create account <span aria-hidden="true">→</span></span>
              </button>
            </div>

            <div *ngIf="activeTab === 'register'" class="link-row">
              <button type="button" class="auth-switch-btn" (click)="setTab('login')">
                <span>Already have an account?</span>
                <span class="auth-switch-action">Log in <span aria-hidden="true">→</span></span>
              </button>
            </div>

            <div class="link-row margin-top-xs">
              <a class="underlined-link" (click)="setTab('forgot')">Forgot Password</a>
            </div>
          </div>
        </form>

        <!-- FORGOT PASSWORD — DIRECT RESET (no OTP) -->
        <div *ngIf="activeTab === 'forgot'" class="auth-form">
          <form (ngSubmit)="onResetPassword()">
            <p class="step-info-text">
              Enter the phone number on your account and choose a new password.
              You will be able to log in with it straight away.
            </p>

            <div class="form-group">
              <div class="select-wrapper">
                <select [(ngModel)]="selectedCountry" name="country" class="country-select">
                  <option value="+254">Kenya (+254)</option>
                  <option value="+255">Tanzania (+255)</option>
                  <option value="+256">Uganda (+256)</option>
                  <option value="+234">Nigeria (+234)</option>
                  <option value="+27">South Africa (+27)</option>
                </select>
                <span class="select-arrow">▼</span>
              </div>
            </div>

            <div class="form-group margin-top-sm">
              <div class="phone-input-row">
                <div class="country-code-box">{{ selectedCountry }}</div>
                <input
                  type="text"
                  [(ngModel)]="phone"
                  name="phone"
                  class="phone-input"
                  placeholder="Phone Number (9 digits)"
                  required
                />
              </div>
              <div class="field-hint">Enter your phone number without leading zeros</div>
            </div>

            <div class="form-group margin-top-sm">
              <label class="input-label">New Password</label>
              <div class="password-input-wrapper">
                <input
                  [type]="showPassword ? 'text' : 'password'"
                  [(ngModel)]="newPassword"
                  name="newPassword"
                  class="password-input"
                  placeholder="New Password (min 6 characters)"
                  required
                />
                <button type="button" class="password-toggle-btn" (click)="toggleShowPassword()">
                  {{ showPassword ? 'HIDE' : 'SHOW' }}
                </button>
              </div>
            </div>

            <div class="form-group margin-top-sm">
              <label class="input-label">Confirm New Password</label>
              <div class="password-input-wrapper">
                <input
                  [type]="showPassword ? 'text' : 'password'"
                  [(ngModel)]="confirmNewPassword"
                  name="confirmNewPassword"
                  class="password-input"
                  placeholder="Confirm New Password"
                  required
                />
              </div>
            </div>

            <button type="submit" class="submit-blue-btn" [disabled]="isSubmitting">
              {{ isSubmitting ? 'RESETTING...' : 'RESET PASSWORD' }}
            </button>
          </form>

          <div class="auth-links-footer">
            <div class="link-row">
              <span>Remembered password? </span>
              <a class="underlined-link" (click)="setTab('login')">Log in here</a>
            </div>
          </div>
        </div>
    </div>
  `,
  styles: [`
/* ═══════════════════════════════════════════════════════════════════════
       Winbet auth — rich dark brown + warm gold, matching the sportsbook chrome.
       ═══════════════════════════════════════════════════════════════════════ */
    :host {
      --wb-brown: #5c2d14;
      --wb-brown-light: #8c4820;
      --wb-brown-deep: #241108;
      --wb-gold: #ffd026;
      --wb-gold-deep: #c99800;
      --wb-red: #e8202a;
      --wb-ink: #f7efe8;
      --wb-muted: #c7afa0;
      --wb-panel: rgba(34, 17, 9, .88);
      --wb-line: rgba(196, 128, 72, .28);
    }

    .auth-landing-wrapper {
      position: relative;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px 16px 40px;
      background:
        radial-gradient(120% 90% at 50% -10%, #5c2d14 0%, #2b1409 42%, #0e0603 100%);
      font-family: Inter, 'Segoe UI', Roboto, system-ui, sans-serif;
      color: var(--wb-ink);
      overflow: hidden;
    }

    /* Gold haze behind the card, plus a slow drifting warm bronze sheen. */
    .glow-backdrop {
      position: absolute;
      inset: -20%;
      pointer-events: none;
      background:
        radial-gradient(38% 30% at 22% 18%, rgba(255, 208, 38, .15), transparent 70%),
        radial-gradient(42% 34% at 80% 78%, rgba(156, 86, 40, .24), transparent 72%);
      animation: wb-drift 16s ease-in-out infinite alternate;
    }
    @keyframes wb-drift {
      from { transform: translate3d(-2%, -1%, 0) scale(1); }
      to   { transform: translate3d(3%, 2%, 0) scale(1.06); }
    }

    .glass-card {
      position: relative;
      z-index: 2;
      width: min(430px, 100%);
      background: var(--wb-panel);
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
      border: 1px solid var(--wb-line);
      border-radius: 18px;
      padding: 26px 24px 28px;
      box-shadow:
        0 26px 70px rgba(0, 0, 0, .66),
        inset 0 1px 0 rgba(255, 224, 184, .08);
    }
    /* Gold hairline along the top edge. */
    .glass-card::before {
      content: '';
      position: absolute;
      inset: 0 0 auto 0;
      height: 2px;
      border-radius: 18px 18px 0 0;
      background: linear-gradient(90deg, transparent, var(--wb-gold), transparent);
    }

    .fade-in { animation: wb-in .34s ease; }
    @keyframes wb-in { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
    .fade-out { animation: wb-out .34s ease forwards; }
    @keyframes wb-out { to { opacity: 0; transform: translateY(-10px); } }

    /* ── Loading card ─────────────────────────────────────────────────── */
    .loading-modal-card { text-align: center; }
    .aviator-brand { display: flex; justify-content: center; margin-bottom: 20px; }

    .site-logo-image {
      width: min(230px, 68%);
      border-radius: 16px;
      object-fit: contain;
      box-shadow: 0 12px 34px rgba(0, 0, 0, .55);
    }
    .auth-site-logo {
      display: block;
      width: min(150px, 46%);
      margin: 0 auto 14px;
    }

    .progress-bar-container {
      height: 12px;
      border-radius: 999px;
      background: rgba(255, 255, 255, .09);
      overflow: hidden;
      border: 1px solid var(--wb-line);
    }
    .progress-bar-fill {
      height: 100%;
      border-radius: 999px;
      background: linear-gradient(90deg, var(--wb-brown), var(--wb-brown-light) 55%, var(--wb-gold));
      box-shadow: 0 0 14px rgba(255, 208, 38, .45);
      transition: width .25s ease;
    }
    .progress-percent-text {
      margin-top: 10px;
      font-size: 26px;
      font-weight: 900;
      color: var(--wb-gold);
      letter-spacing: -.5px;
    }
    .loading-status-text { color: var(--wb-muted); font-size: 13px; margin-top: 2px; }

    .speedup-circle-btn {
      margin: 22px auto 0;
      width: 96px;
      height: 96px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      cursor: pointer;
      border: 2px solid var(--wb-gold);
      background: radial-gradient(circle at 34% 28%, #8c4820 0%, #5c2d14 48%, #241108 100%);
      box-shadow: 0 0 0 6px rgba(255, 208, 38, .12), 0 14px 30px rgba(0, 0, 0, .55);
      animation: wb-pulse 2.1s ease-in-out infinite;
    }
    @keyframes wb-pulse {
      0%, 100% { box-shadow: 0 0 0 6px rgba(255, 208, 38, .12), 0 14px 30px rgba(0, 0, 0, .55); }
      50%      { box-shadow: 0 0 0 14px rgba(255, 208, 38, .05), 0 14px 30px rgba(0, 0, 0, .55); }
    }
    .speedup-text { font-size: 14px; font-weight: 900; letter-spacing: 1px; color: #fff; }
    .speedup-hint-text { margin-top: 12px; font-size: 12px; color: var(--wb-muted); }

    /* ── Auth card ────────────────────────────────────────────────────── */
    .auth-title {
      margin: 0 0 18px;
      text-align: center;
      font-size: 23px;
      font-weight: 900;
      letter-spacing: -.4px;
      color: #fff;
    }

    .alert-box {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 11px 13px;
      border-radius: 10px;
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 14px;
      line-height: 1.4;
    }
    .alert-box.error {
      background: rgba(232, 32, 42, .14);
      border: 1px solid rgba(232, 32, 42, .4);
      color: #ffb3b7;
    }
    .alert-box.success {
      background: rgba(22, 194, 91, .14);
      border: 1px solid rgba(22, 194, 91, .42);
      color: #a8f0c4;
    }

    .auth-form { display: block; }
    .form-group { display: block; }
    .margin-top-sm { margin-top: 12px; }
    .margin-top-xs { margin-top: 8px; }
    .text-center { text-align: center; }
    .font-bold { font-weight: 800; }
    .letter-spacing-lg { letter-spacing: 6px; }

    .input-label {
      display: block;
      font-size: 11.5px;
      font-weight: 800;
      letter-spacing: .4px;
      text-transform: uppercase;
      color: var(--wb-muted);
      margin-bottom: 6px;
    }

    .select-wrapper { position: relative; }
    .country-select,
    .phone-input,
    .password-input,
    .standard-input {
      width: 100%;
      padding: 13px 14px;
      border-radius: 10px;
      border: 1px solid var(--wb-line);
      background: rgba(255, 255, 255, .05);
      color: #fff;
      font-size: 14.5px;
      font-family: inherit;
      outline: none;
      transition: border-color .16s, box-shadow .16s, background .16s;
    }
    .country-select { appearance: none; cursor: pointer; padding-right: 38px; }
    .country-select option { background: #261309; color: #fff; }
    .select-arrow {
      position: absolute;
      right: 14px;
      top: 50%;
      transform: translateY(-50%);
      font-size: 10px;
      color: var(--wb-gold);
      pointer-events: none;
    }

    .country-select:focus,
    .phone-input:focus,
    .password-input:focus,
    .standard-input:focus {
      border-color: var(--wb-gold);
      background: rgba(255, 255, 255, .08);
      box-shadow: 0 0 0 3px rgba(255, 208, 38, .18);
    }
    .phone-input::placeholder,
    .password-input::placeholder,
    .standard-input::placeholder { color: rgba(240, 224, 210, .38); }

    .phone-input-row { display: flex; gap: 8px; }
    .country-code-box {
      flex: 0 0 auto;
      display: grid;
      place-items: center;
      min-width: 70px;
      padding: 0 12px;
      border-radius: 10px;
      background: linear-gradient(150deg, var(--wb-brown), var(--wb-brown-deep));
      border: 1px solid var(--wb-line);
      font-size: 14px;
      font-weight: 800;
      color: #fff;
    }
    .field-hint { margin-top: 6px; font-size: 11.5px; color: var(--wb-muted); line-height: 1.4; }

    .password-input-wrapper { position: relative; }
    .password-input { padding-right: 68px; }
    .password-toggle-btn {
      position: absolute;
      right: 8px;
      top: 50%;
      transform: translateY(-50%);
      padding: 6px 10px;
      border: none;
      border-radius: 7px;
      background: rgba(255, 208, 38, .16);
      color: var(--wb-gold);
      font-size: 10.5px;
      font-weight: 900;
      letter-spacing: .4px;
      cursor: pointer;
    }
    .password-toggle-btn:hover { background: rgba(255, 208, 38, .26); }

    .auth-submit-btn,
    .submit-blue-btn {
      width: 100%;
      margin-top: 18px;
      padding: 14px 18px;
      border: none;
      border-radius: 11px;
      font-size: 15px;
      font-weight: 900;
      letter-spacing: .5px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 9px;
      background: linear-gradient(135deg, var(--wb-gold), #e5a800);
      color: #1c1008;
      box-shadow: 0 8px 22px rgba(255, 208, 38, .26);
      transition: transform .12s, box-shadow .16s, filter .16s;
    }
    .auth-submit-btn:hover:not(:disabled),
    .submit-blue-btn:hover:not(:disabled) { transform: translateY(-1px); filter: brightness(1.04); }
    .auth-submit-btn:active:not(:disabled) { transform: translateY(1px); }
    .auth-submit-btn:disabled,
    .submit-blue-btn:disabled { opacity: .6; cursor: not-allowed; box-shadow: none; }

    /* Register and reset flows use the rich roasted brown fill so the two paths read apart. */
    .auth-submit-btn.register-mode,
    .submit-blue-btn {
      background: linear-gradient(135deg, var(--wb-brown-light), var(--wb-brown));
      color: #fff;
      border: 1px solid rgba(255, 208, 38, .35);
      box-shadow: 0 8px 22px rgba(92, 45, 20, .42);
    }
    .auth-submit-arrow { font-size: 17px; line-height: 1; }

    .auth-links-footer { margin-top: 18px; }
    .link-row {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      font-size: 13px;
      color: var(--wb-muted);
    }

    .auth-switch-btn {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 12px 14px;
      border: 1px dashed var(--wb-line);
      border-radius: 11px;
      background: rgba(255, 255, 255, .03);
      color: var(--wb-muted);
      font-family: inherit;
      font-size: 13px;
      cursor: pointer;
      transition: border-color .16s, background .16s;
    }
    .auth-switch-btn:hover { border-color: var(--wb-gold); background: rgba(255, 208, 38, .07); }
    .auth-switch-action { color: var(--wb-gold); font-weight: 800; white-space: nowrap; }

    .underlined-link {
      color: #e6b87d;
      font-weight: 700;
      text-decoration: underline;
      text-underline-offset: 3px;
      cursor: pointer;
    }
    .underlined-link:hover { color: var(--wb-gold); }

    .step-info-text {
      margin: 0 0 16px;
      font-size: 13px;
      line-height: 1.55;
      color: var(--wb-muted);
      text-align: center;
    }

    .target-phone-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 11px 13px;
      border-radius: 10px;
      background: rgba(140, 72, 32, .16);
      border: 1px solid var(--wb-line);
      font-size: 12.5px;
      color: var(--wb-ink);
    }
    .target-phone-banner strong { color: var(--wb-gold); }
    .change-phone-link {
      color: var(--wb-gold);
      font-weight: 800;
      cursor: pointer;
      text-decoration: underline;
      white-space: nowrap;
    }
    .resend-row { font-size: 12.5px; }

    @media (max-width: 480px) {
      .auth-landing-wrapper { padding: 16px 12px 32px; }
      .glass-card { padding: 22px 18px 24px; border-radius: 16px; }
      .auth-title { font-size: 20px; }
      .speedup-circle-btn { width: 84px; height: 84px; }
    }
  `]
})
export class AuthLandingComponent implements OnInit, OnDestroy {
  private authService = inject(AuthService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  // Loading animation state
  isLoading = false;
  loadingProgress = 100;
  isFadingOut = false;
  private loadingInterval: any = null;

  // Form State
  activeTab: 'login' | 'register' | 'forgot' = 'login';
  selectedCountry = '+254';
  phone = '';
  password = '';
  confirmPassword = '';
  // Optional promo code entered at sign-up. Never required.
  promoCode = '';
  showPassword = false;

  // Forgot password reset fields
  newPassword = '';
  confirmNewPassword = '';

  errorMessage: string | null = null;
  successMessage: string | null = null;
  isSubmitting = false;
  private loginWatchdog: ReturnType<typeof setTimeout> | null = null;
  private resetWatchdog: ReturnType<typeof setTimeout> | null = null;

  ngOnInit() {
    if (this.route.snapshot.queryParamMap.get('mode') === 'register') this.setTab('register');
    if (this.authService.hasToken()) {
      this.authService.loadCurrentUser().subscribe(res => {
        if (res?.user) {
          const dest = res.user.role === 'admin' ? '/admin' : '/bets';
          this.router.navigate([dest]);
        }
      });
    }
  }

  ngOnDestroy() {
    if (this.loadingInterval) {
      clearInterval(this.loadingInterval);
    }
    if (this.loginWatchdog) {
      clearTimeout(this.loginWatchdog);
    }
    if (this.resetWatchdog) {
      clearTimeout(this.resetWatchdog);
    }
  }

  startLoadingProcess() {
    this.isLoading = true;
    this.loadingProgress = 0;
    this.isFadingOut = false;

    // Ultra-smooth auto loading (~350ms total)
    const stepMs = 20;
    this.loadingInterval = setInterval(() => {
      if (this.loadingProgress < 100) {
        const inc = Math.floor(Math.random() * 8) + 8;
        this.loadingProgress = Math.min(100, this.loadingProgress + inc);
      }

      if (this.loadingProgress >= 100) {
        if (this.loadingInterval) clearInterval(this.loadingInterval);
        this.finishLoading();
      }
    }, stepMs);
  }

  speedUpLoading() {
    if (this.loadingProgress < 100) {
      this.loadingProgress = 100;
      if (this.loadingInterval) clearInterval(this.loadingInterval);
      this.finishLoading();
    }
  }

  private finishLoading() {
    this.isFadingOut = true;
    setTimeout(() => {
      this.isLoading = false;
      this.isFadingOut = false;
    }, 250);
  }

  cleanPromoCode(value: string) {
    this.promoCode = (value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  }

  toggleShowPassword() {
    this.showPassword = !this.showPassword;
  }

  setTab(tab: 'login' | 'register' | 'forgot') {
    this.activeTab = tab;
    this.errorMessage = null;
    this.successMessage = null;
    this.newPassword = '';
    this.confirmNewPassword = '';
  }

  private formatPhone(rawPhone: string): { fullPhone: string; rawPhone: string } {
    const trimmed = (rawPhone || '').trim();
    let cleaned = trimmed.replace(/[^\d+]/g, '');

    if (!cleaned) return { fullPhone: '', rawPhone: trimmed };

    const countryNoPlus = this.selectedCountry.replace('+', '');

    if (cleaned.startsWith('+')) {
      if (cleaned.startsWith(`+${countryNoPlus}0`)) {
        cleaned = `+${countryNoPlus}` + cleaned.slice(countryNoPlus.length + 2);
      }
      return { fullPhone: cleaned, rawPhone: trimmed };
    }

    const localDigits = cleaned.replace(/^0+/, '');
    return {
      fullPhone: `${this.selectedCountry}${localDigits}`,
      rawPhone: trimmed
    };
  }

  onSubmit() {
    if (this.activeTab === 'login') {
      this.onLogin();
    } else if (this.activeTab === 'register') {
      this.onRegister();
    }
  }

  onLogin() {
    const trimmed = this.phone.trim();
    if (!trimmed || !this.password) {
      this.errorMessage = 'Please enter your phone number/username and password.';
      return;
    }

    const { fullPhone } = this.formatPhone(trimmed);
    const loginValue = /[a-z@]/i.test(trimmed) ? trimmed : fullPhone;

    this.isSubmitting = true;
    this.errorMessage = null;
    this.loginWatchdog = setTimeout(() => {
      if (!this.isSubmitting) return;
      this.isSubmitting = false;
      this.errorMessage = 'Login is taking too long. Please try again.';
    }, 12000);

    this.authService.login({ username: loginValue, password: this.password }).subscribe({
      next: (res) => {
        this.completeLoginAttempt();
        const role = (res.user?.role || '').toLowerCase();
        const dest = (role === 'admin' || role === 'super_admin' || role === 'superadmin') ? '/admin' : '/bets';
        this.router.navigate([dest]);
      },
      error: (err) => {
        this.completeLoginAttempt();
        this.errorMessage = typeof err === 'string' ? err : 'Login failed. Please check your phone number/username and password.';
      }
    });
  }

  private completeLoginAttempt() {
    if (this.loginWatchdog) {
      clearTimeout(this.loginWatchdog);
      this.loginWatchdog = null;
    }
    this.isSubmitting = false;
  }

  onRegister() {
    const trimmed = this.phone.trim();
    if (!trimmed || !this.password) {
      this.errorMessage = 'Phone number and password are required.';
      return;
    }
    if (this.password.length < 6) {
      this.errorMessage = 'Password must be at least 6 characters long.';
      return;
    }
    if (this.password !== this.confirmPassword) {
      this.errorMessage = 'Passwords do not match.';
      return;
    }

    const { fullPhone } = this.formatPhone(trimmed);

    this.isSubmitting = true;
    this.errorMessage = null;

    this.authService.register({
      username: fullPhone,
      phone_number: fullPhone,
      password: this.password,
      promo_code: this.promoCode.trim() || undefined
    }).subscribe({
      next: () => {
        this.isSubmitting = false;
        this.router.navigate(['/bets']);
      },
      error: (err) => {
        this.isSubmitting = false;
        this.errorMessage = typeof err === 'string' ? err : 'Registration failed. Please try again.';
      }
    });
  }

  // FORGOT PASSWORD — DIRECT RESET
  // There is no SMS gateway wired up, so the previous OTP step generated its
  // code in the browser and never sent it anywhere; players were left waiting
  // for a message that could not arrive. The backend reset endpoint has never
  // required an OTP, so the form now posts the new password straight to it.
  onResetPassword() {
    const trimmed = this.phone.trim();

    if (!trimmed) {
      this.errorMessage = 'Please enter your registered phone number.';
      return;
    }
    if (!this.newPassword) {
      this.errorMessage = 'Please enter a new password.';
      return;
    }
    if (this.newPassword.length < 6) {
      this.errorMessage = 'New password must be at least 6 characters long.';
      return;
    }
    if (this.newPassword !== this.confirmNewPassword) {
      this.errorMessage = 'New passwords do not match.';
      return;
    }

    const { fullPhone, rawPhone } = this.formatPhone(trimmed);
    this.isSubmitting = true;
    this.errorMessage = null;
    this.successMessage = null;

    // Backstop for the two chained requests below. Without it a stalled API
    // leaves the button reading "RESETTING..." with no way out.
    if (this.resetWatchdog) clearTimeout(this.resetWatchdog);
    this.resetWatchdog = setTimeout(() => {
      if (!this.isSubmitting) return;
      this.isSubmitting = false;
      this.errorMessage = 'The server is taking too long to respond. It may be waking up — please try again.';
    }, 45000);

    const finish = () => {
      this.isSubmitting = false;
      if (this.resetWatchdog) { clearTimeout(this.resetWatchdog); this.resetWatchdog = null; }
    };

    const succeed = () => {
      finish();
      this.successMessage = 'Password reset successfully. Log in with your new password.';
      this.activeTab = 'login';
      this.password = '';
      this.newPassword = '';
      this.confirmNewPassword = '';
    };

    this.authService.resetPassword({ phone_number: fullPhone, new_password: this.newPassword }).subscribe({
      next: succeed,
      error: () => {
        // Older accounts were stored without the country code, so retry raw.
        this.authService.resetPassword({ phone_number: rawPhone, new_password: this.newPassword }).subscribe({
          next: succeed,
          error: (err) => {
            finish();
            this.errorMessage = typeof err === 'string' ? err : 'Password reset failed. That phone number is not registered.';
          }
        });
      }
    });
  }
}