import {
  Component,
  OnInit,
  AfterViewInit,
  OnDestroy,
  ViewChild,
  ElementRef,
  HostListener,
  signal,
  WritableSignal,
  computed,
  effect,
  inject,
  isDevMode,
  NgZone
} from '@angular/core';
import { CommonModule, Location } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Subscription, finalize } from 'rxjs';
import { ChatMessage, GameSocketService, LiveBetBroadcast, SourceGameBet } from '../../../core/services/game-socket.service';
import { AuthService, User, TransactionRecord } from '../../../core/services/auth.service';
import { GameSoundService } from '../../../core/services/game-sound.service';
import { AviatorFlightRenderer } from './aviator-flight-renderer';
import { GameAvatarComponent, REFERENCE_AVATARS } from './game-avatar.component';
import { verifyPlatformEnvironment } from '../../../core/security/platform-integrity';


export type GameState = 'WAITING' | 'RUNNING' | 'CRASHED';
type GameMenuPage = 'avatar' | 'free-bets' | 'history' | 'limits' | 'help' | 'rules' | 'fairness';

export interface LiveBet {
  id: string;
  player: string;
  avatarIcon: string;
  bet: number;
  multiplier: number | null;
  win: number;
  cashedOut: boolean;
  isCurrentUser?: boolean;
  targetMultiplier?: number;
}

export interface PanelBetState {
  amount: number;
  selectedPreset: number | null;
  presetTapCount: number;
  placedAmount: number;
  queuedAmount: number;
  mode: 'bet' | 'auto';
  autoBetEnabled: boolean;
  autoCashoutEnabled: boolean;
  autoTarget: number;
  isPending: boolean;
  hasActiveBet: boolean;
  hasCashedOut: boolean;
  cashedOutPayout: number;
  cashedOutMultiplier: number;
}

export interface RoomState {
  id: number;
  name: string;
  panel1: WritableSignal<PanelBetState>;
  panel2: WritableSignal<PanelBetState>;
  gameState: WritableSignal<GameState>;
  currentMultiplier: WritableSignal<number>;
  animatedMultiplier: WritableSignal<number>;
  finalCrashMultiplier: WritableSignal<number>;
  countdownSeconds: WritableSignal<number>;
  countdownProgress: WritableSignal<number>;
  history: WritableSignal<number[]>;
  liveBets: WritableSignal<LiveBet[]>;
  flightProgress: number;
  crashFlightProgress: number;
  flyingStartedAt: number;
  bettingIntervalId?: any;
  mockLoopIntervalId?: any;
  fakeJoinIntervalId?: any;
}

export interface UserBetHistoryItem {
  id: string;
  time: string;
  date: string;
  bet: number;
  multiplier: number;
  win: number;
  cashedOut: boolean;
  rawTimestamp?: number;
}

interface CashoutNotification {
  id: number;
  multiplier: number;
  payout: number;
  slot: 1 | 2;
}

@Component({
  selector: 'app-aviator-game',
  standalone: true,
  imports: [CommonModule, FormsModule, GameAvatarComponent],
  templateUrl: './aviator-game.component.html',
  styleUrls: ['./aviator-game.component.scss', './aviator-board.component.scss', './aviator-menu.component.scss', './aviator-history.component.scss']
})
export class AviatorGameComponent implements OnInit, AfterViewInit, OnDestroy {
  // Development review frames share the real authenticated page and cannot place bets.
  public readonly visualPreview = isDevMode() && typeof window !== 'undefined'
    ? ['takeoff', 'flight-blue', 'flight-purple', 'flight-mobile', 'waiting', 'crashed'].find(frame => frame === new URLSearchParams(window.location.search).get('preview'))
    : undefined;
  public readonly takeoffPreview = this.visualPreview === 'takeoff';
  public readonly startupPreview = isDevMode() && typeof window !== 'undefined'
    ? ['loading', 'offline', 'connection'].find(frame => frame === new URLSearchParams(window.location.search).get('preview'))
    : undefined;
  public readonly previewMultiplier = this.visualPreview === 'flight-blue' ? 1.99
    : this.visualPreview === 'flight-purple' ? 6.10 : this.visualPreview === 'flight-mobile' ? 3.22 : null;
  public panel2Collapsed = signal<boolean>(false);
  public togglePanel2() {
    this.panel2Collapsed.update(c => !c);
  }

  public toggleAutoBet(panelIndex: 1 | 2) {
    if (panelIndex === 1) {
      this.panel1.update(p => ({ ...p, autoBetEnabled: !p.autoBetEnabled }));
    } else {
      this.panel2.update(p => ({ ...p, autoBetEnabled: !p.autoBetEnabled }));
    }
  }

  public toggleAutoCashout(panelIndex: 1 | 2) {
    if (panelIndex === 1) {
      this.panel1.update(p => ({ ...p, autoCashoutEnabled: !p.autoCashoutEnabled }));
    } else {
      this.panel2.update(p => ({ ...p, autoCashoutEnabled: !p.autoCashoutEnabled }));
    }
  }

  public resetAutoCashout(panelIndex: 1 | 2) {
    if (panelIndex === 1) {
      this.panel1.update(p => ({ ...p, autoTarget: 1.10 }));
    } else {
      this.panel2.update(p => ({ ...p, autoTarget: 1.10 }));
    }
  }

  @HostListener('document:visibilitychange')
  public onDocumentVisibilityChange(): void {
    if (typeof document !== 'undefined' && document.hidden) {
      this.gameSound.stopAllAudio();
    } else {
      this.syncAudioWithActiveRoom();
    }
  }

  @HostListener('window:pagehide')
  public onPageHide(): void {
    this.gameSound.stopAllAudio();
  }

  @HostListener('window:blur')
  public onWindowBlur(): void {
    this.gameSound.stopAllAudio();
  }

  @HostListener('window:focus')
  public onWindowFocus(): void {
    this.syncAudioWithActiveRoom();
  }

  public syncAudioWithActiveRoom(): void {
    if (!this.musicEnabled() || (typeof document !== 'undefined' && document.hidden)) {
      this.gameSound.stopBackground();
      return;
    }
    const currentRoom = this.activeRoom();
    if (currentRoom && currentRoom.gameState() === 'RUNNING') {
      this.gameSound.playBackground();
    } else {
      this.gameSound.stopBackground();
    }
  }

  @ViewChild('flightCanvas') canvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('canvasContainer') canvasContainerRef!: ElementRef<HTMLDivElement>;
  @ViewChild('chatScroll') chatScrollRef?: ElementRef<HTMLDivElement>;
  @ViewChild('roundHistoryToggle') roundHistoryToggleRef?: ElementRef<HTMLButtonElement>;

  private gameSocket = inject(GameSocketService);
  private authService = inject(AuthService);
  private gameSound = inject(GameSoundService);
  private router = inject(Router);
  private location = inject(Location);
  private ngZone = inject(NgZone);

  private subs: Subscription[] = [];
  private animationFrameId: number | null = null;
  private bettingIntervalId: any = null;
  private mockLoopIntervalId: any = null;
  private resizeObserver: ResizeObserver | null = null;
  private fakeJoinIntervalId: any = null;
  private lastMultiplierFrameAt = performance.now();
  private lastMultiplierPublishAt = 0;
  private canvasRoomId = -1;
  private canvasPhase: GameState | null = null;
  private flightRenderer: AviatorFlightRenderer | null = null;
  private renderedMultiplierValue = 1;
  private flightClockRoomId = -1;
  private flightClockServerStart = 0;
  private flightClockAnchor = 0;
  private flightClockAge = 0;
  private crashFlightProgress = 0;
  private flyingPhaseStartedAt = 0;

  // --------------------------------------------------------------------------
  // ANGULAR SIGNALS STATE MACHINE
  // --------------------------------------------------------------------------
  public selectedRoom = signal<number>(1);
  public showChangeRoomModal = signal<boolean>(false);
  public pendingRoomSelection = signal<number>(1);

  public room1: RoomState = {
    id: 1,
    name: 'Room #1',
    panel1: signal<PanelBetState>({
      amount: 10, selectedPreset: null, presetTapCount: 0, placedAmount: 0, queuedAmount: 0,
      mode: 'bet', autoBetEnabled: false, autoCashoutEnabled: false, autoTarget: 1.10, isPending: false, hasActiveBet: false, hasCashedOut: false,
      cashedOutPayout: 0, cashedOutMultiplier: 0
    }),
    panel2: signal<PanelBetState>({
      amount: 10, selectedPreset: null, presetTapCount: 0, placedAmount: 0, queuedAmount: 0,
      mode: 'bet', autoBetEnabled: false, autoCashoutEnabled: false, autoTarget: 1.10, isPending: false, hasActiveBet: false, hasCashedOut: false,
      cashedOutPayout: 0, cashedOutMultiplier: 0
    }),
    gameState: signal<GameState>('WAITING'),
    currentMultiplier: signal<number>(1.00),
    animatedMultiplier: signal<number>(1.00),
    finalCrashMultiplier: signal<number>(1.00),
    countdownSeconds: signal<number>(5),
    countdownProgress: signal<number>(100),
    history: signal<number[]>([
      1.39, 1.40, 1.36, 2.23, 1.19, 1.50, 1.90, 2.29, 3.98,
      4.09, 1.87, 1.09, 14.22, 1.56, 2.03, 1.10, 1.38, 3.57,
      1.30, 3.34, 29.69, 10.30, 1.34, 2.09, 1.50, 1.14, 1.29,
      3.36, 2.35
    ]),
    liveBets: signal<LiveBet[]>([]),
    flightProgress: 0,
    crashFlightProgress: 0,
    flyingStartedAt: 0,
    bettingIntervalId: null,
    mockLoopIntervalId: null,
    fakeJoinIntervalId: null
  };

  public room2: RoomState = {
    id: 2,
    name: 'Room #2',
    panel1: signal<PanelBetState>({
      amount: 10, selectedPreset: null, presetTapCount: 0, placedAmount: 0, queuedAmount: 0,
      mode: 'bet', autoBetEnabled: false, autoCashoutEnabled: false, autoTarget: 1.10, isPending: false, hasActiveBet: false, hasCashedOut: false,
      cashedOutPayout: 0, cashedOutMultiplier: 0
    }),
    panel2: signal<PanelBetState>({
      amount: 10, selectedPreset: null, presetTapCount: 0, placedAmount: 0, queuedAmount: 0,
      mode: 'bet', autoBetEnabled: false, autoCashoutEnabled: false, autoTarget: 1.10, isPending: false, hasActiveBet: false, hasCashedOut: false,
      cashedOutPayout: 0, cashedOutMultiplier: 0
    }),
    gameState: signal<GameState>('WAITING'),
    currentMultiplier: signal<number>(1.00),
    animatedMultiplier: signal<number>(1.00),
    finalCrashMultiplier: signal<number>(1.00),
    countdownSeconds: signal<number>(5),
    countdownProgress: signal<number>(100),
    history: signal<number[]>([
      2.15, 1.45, 5.60, 1.10, 3.25, 1.80, 8.90, 2.05, 1.50, 4.10,
      1.22, 3.45, 1.95, 6.70, 2.30, 1.18, 2.80, 1.05, 4.50, 1.60
    ]),
    liveBets: signal<LiveBet[]>([]),
    flightProgress: 0,
    crashFlightProgress: 0,
    flyingStartedAt: 0,
    bettingIntervalId: null,
    mockLoopIntervalId: null,
    fakeJoinIntervalId: null
  };

  public room3: RoomState = {
    id: 3,
    name: 'Room #3',
    panel1: signal<PanelBetState>({
      amount: 10, selectedPreset: null, presetTapCount: 0, placedAmount: 0, queuedAmount: 0,
      mode: 'bet', autoBetEnabled: false, autoCashoutEnabled: false, autoTarget: 1.10, isPending: false, hasActiveBet: false, hasCashedOut: false,
      cashedOutPayout: 0, cashedOutMultiplier: 0
    }),
    panel2: signal<PanelBetState>({
      amount: 10, selectedPreset: null, presetTapCount: 0, placedAmount: 0, queuedAmount: 0,
      mode: 'bet', autoBetEnabled: false, autoCashoutEnabled: false, autoTarget: 1.10, isPending: false, hasActiveBet: false, hasCashedOut: false,
      cashedOutPayout: 0, cashedOutMultiplier: 0
    }),
    gameState: signal<GameState>('WAITING'),
    currentMultiplier: signal<number>(1.00),
    animatedMultiplier: signal<number>(1.00),
    finalCrashMultiplier: signal<number>(1.00),
    countdownSeconds: signal<number>(5),
    countdownProgress: signal<number>(100),
    history: signal<number[]>([
      1.08, 3.90, 1.75, 12.40, 1.30, 2.40, 1.90, 6.70, 1.15, 2.80,
      1.55, 4.20, 1.02, 2.10, 8.50, 1.40, 3.10, 2.05, 1.25, 5.80
    ]),
    liveBets: signal<LiveBet[]>([]),
    flightProgress: 0,
    crashFlightProgress: 0,
    flyingStartedAt: 0,
    bettingIntervalId: null,
    mockLoopIntervalId: null,
    fakeJoinIntervalId: null
  };

  public getRoom(id: number): RoomState {
    if (id === 2) return this.room2;
    if (id === 3) return this.room3;
    return this.room1;
  }

  public activeRoom = computed(() => this.getRoom(this.selectedRoom()));
  // The template and existing bet controls continue to use panel1/panel2,
  // while the getter keeps those controls scoped to the selected room.
  public get panel1(): WritableSignal<PanelBetState> {
    return this.activeRoom().panel1;
  }

  public get panel2(): WritableSignal<PanelBetState> {
    return this.activeRoom().panel2;
  }

  public gameState = computed(() => this.activeRoom().gameState());
  public currentMultiplier = computed(() => this.activeRoom().currentMultiplier());
  public animatedMultiplier = computed(() => this.activeRoom().animatedMultiplier());
  public displayedMultiplier = computed(() => this.previewMultiplier ?? this.animatedMultiplier());
  public visualGameState = computed<GameState>(() => this.visualPreview === 'crashed' ? 'CRASHED'
    : this.visualPreview === 'waiting' ? 'WAITING'
    : this.visualPreview ? 'RUNNING' : this.gameState());
  public displayedCrashMultiplier = computed(() => this.visualPreview === 'crashed' ? 1.67
    : this.finalCrashMultiplier());
  public isTakingOff = computed(() => this.takeoffPreview || (this.visualGameState() === 'RUNNING' && this.displayedMultiplier() <= 1.04));
  public finalCrashMultiplier = computed(() => this.activeRoom().finalCrashMultiplier());
  public countdownSeconds = computed(() => this.activeRoom().countdownSeconds());
  public countdownProgress = computed(() => this.activeRoom().countdownProgress());
  public history = computed(() => this.activeRoom().history());
  public liveBets = computed(() => this.activeRoom().liveBets());

  public userBalance = signal<number>(0.00);
  public hasCompletedFirstDeposit = signal<boolean>(false);
  public isConnected = signal<boolean>(false);
  public activeTab = signal<'all' | 'my' | 'top'>('all');

  private readonly maxBetFeedSize = 3000;
  private readonly visibleBetRows = 100;

  // Modals & UI overlays
  public showWalletModal = signal<boolean>(false);
  public showHistoryModal = signal<boolean>(false);
  public showExpandedHistory = signal<boolean>(false);
  public userBetHistoryList = signal<UserBetHistoryItem[]>([]);
  public betHistoryLimit = signal<number>(10);
  public showProfileModal = signal<boolean>(false);
  public showProfileDropdown = signal<boolean>(false);
  public walletTab = signal<'deposit' | 'withdraw' | 'transactions'>('deposit');
  public depositVal = signal<number>(999);
  public minDepositAmount = signal<number>(999);
  public maxDepositAmount = signal<number>(1999);
  public depositCooldownSeconds = signal<number>(0);
  private depositCooldownTimer: any = null;
  public depositSelectedPreset = signal<number | null>(null);
  public depositPresetTapCount = signal<number>(0);
  public withdrawVal = signal<number>(500);
  public withdrawSelectedPreset = signal<number | null>(null);
  public withdrawPresetTapCount = signal<number>(0);
  public isSubmittingWithdrawal = signal<boolean>(false);
  public toastMessage = signal<string | null>(null);
  public isToastError = signal<boolean>(false);
  public cashoutNotifications = signal<CashoutNotification[]>([]);
  private cashoutNotificationSequence = 0;
  private cashoutNotificationTimeouts: ReturnType<typeof setTimeout>[] = [];

  // Withdrawal / Admin notification pop-up
  public withdrawalNotif = signal<{ id?: number; title: string; message: string; type: string; timestamp: string } | null>(null);
  private withdrawalNotifTimeout: any = null;
  private lastWithdrawalNotificationId: number | null = null;
  public bonusNotif = signal<{ title: string; message: string; type: 'success' | 'info' } | null>(null);
  public isClaimingBonus = signal<boolean>(false);
  public soundEnabled = signal<boolean>(this.gameSound.isEnabled());
  public musicEnabled = signal(this.gameSound.isMusicEnabled());
  public animationEnabled = signal(localStorage.getItem('aviator_animation_enabled') !== 'false');
  public gameAvatar = signal(REFERENCE_AVATARS[0].path);
  public profileDisplayName = computed(() => {
    const user = this.currentUser();
    const phone = user?.phone_number?.replace(/\D/g, '');
    return phone && phone.length >= 9 ? `${phone.slice(0, 6)}XXX${phone.slice(-3)}` : user?.username || 'Player';
  });
  public gameMenuPage = signal<Exclude<GameMenuPage, 'history'> | null>(null);
  public gameMenuTitle = computed(() => {
    const page = this.gameMenuPage();
    return page ? ({ avatar: 'CHANGE AVATAR', 'free-bets': 'FREE BETS', limits: 'GAME LIMITS', help: 'HOW TO PLAY', rules: 'GAME RULES', fairness: 'PROVABLY FAIR SETTINGS' }[page]) : '';
  });
  public gameLimits = signal<{ minBet: number; maxBet: number } | null>(null);
  public gameLimitsLoading = signal(false);
  public readonly gamePreferences = [
    { id: 'sound', label: 'Sound', icon: 'M4 9h4l5-5v16l-5-5H4ZM17 7a7 7 0 0 1 0 10' },
    { id: 'music', label: 'Music', icon: 'M9 18V5l11-3v14M9 9l11-3M9 18a3 2 0 1 1-3-2c2 0 3 1 3 2ZM20 16a3 2 0 1 1-3-2c2 0 3 1 3 2Z' },
    { id: 'animation', label: 'Animation', icon: 'M12 12c-4-11 0-14 2-8 1 3-1 7-2 8Zm0 0c12 2 13 6 7 6-3 0-6-4-7-6Zm0 0c-7 9-12 9-9 4 2-3 6-4 9-4Z' },
  ] as const;
  public readonly gameMenuItems = [
    { id: 'free-bets', label: 'Free Bets', icon: 'm12 2 3 7 8 1-6 5 2 8-7-4-7 4 2-8-6-5 8-1Z' },
    { id: 'history', label: 'My Bet History', icon: 'M3 8V3m0 5h5M3 8a9 9 0 1 1-1 8M12 7v5l4 3' },
    { id: 'limits', label: 'Game Limits', icon: 'M2 7h20v11H2ZM6 7a4 4 0 0 1-4 4m20 0a4 4 0 0 1-4-4M2 14a4 4 0 0 1 4 4m12 0a4 4 0 0 1 4-4M15 12.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z' },
    { id: 'help', label: 'How To Play', icon: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM9 8a3 3 0 1 1 5 2c-2 1-2 2-2 3m0 3v1' },
    { id: 'rules', label: 'Game Rules', icon: 'M7 3h13v17H7ZM3 7h4M3 7v16h13v-3M10 7h7M10 11h7M10 15h5' },
    { id: 'fairness', label: 'Provably Fair Settings', icon: 'm12 2 9 4v6c0 6-9 10-9 10S3 18 3 12V6ZM7 12l3 3 7-7' },
  ] as const;
  public readonly avatarChoices = REFERENCE_AVATARS;
  private pausedAnimationPose: { roomId: number; phase: GameState; multiplier: number } | null = null;
  private bonusNotifTimeout: any = null;

  // Game loading splash screen (shown for 3s after login)
  public gameLoading = signal<boolean>(true);
  public connectionLoading = signal<boolean>(true);
  public networkOnline = signal(typeof navigator === 'undefined' || navigator.onLine);
  public offlineNoticeDismissed = signal(false);
  public showStartupSplash = computed(() => this.gameLoading() || !this.networkOnline()
    || this.startupPreview === 'loading' || this.startupPreview === 'offline');
  public showOfflineNotice = computed(() => (!this.networkOnline() || this.startupPreview === 'offline')
    && !this.offlineNoticeDismissed());
  private startupTimers: ReturnType<typeof setTimeout>[] = [];

  // Transaction History State
  public transactionHistory: TransactionRecord[] = [];
  public isLoadingTransactions = false;
  public transactionHistoryTab = signal<'deposit' | 'withdrawal'>('deposit');

  // M-Pesa STK Push state
  public mpesaPhone = signal<string>('');
  public mpesaStatus = signal<'idle' | 'sending' | 'waiting' | 'success' | 'failed'>('idle');
  public mpesaStatusMsg = signal<string>('');
  public mpesaReceipt = signal<string>('');
  private mpesaCheckoutRequestId: string = '';

  public currentUser = signal<User | null>(null);

  // Live Winbet chat. The server enforces this threshold; the computed value
  // keeps the composer in sync with wallet updates before the next chat event.
  public readonly chatMinimumBalance = 1000;
  public chatOpen = signal<boolean>(false);
  public showNewMessagesPill = signal<boolean>(false);
  public accumulatedNewMessagesCount = signal<number>(0);
  private isUserScrolledUp = false;
  private isUserHoldingChat = false;
  public chatDraft = signal<string>('');
  public chatMessages = signal<ChatMessage[]>([]);
  public chatOnlineCount = signal<number>(8130);
  public chatEligible = computed(() => this.userBalance() >= this.chatMinimumBalance);
  private chatSimulationIntervalId: any = null;
  private chatOnlineIntervalId: any = null;
  private readonly chatFallbackMessages = [
  'Winbet inalipa mbaya sana leo! Nishatoa 45k kwa M-Pesa 🤑',
  'Wazi bro, signals za leo zilikua on point sana, asante Mr Dan 🙏',
  'Nani ako Room 1 sai? Nimeona 18.5x ikitokea plane imepaa safi 🚀',
  'Aki signals ziko legit, nimeanza na 500 nikatoa 14,000!',
  'Deposit ya M-Pesa imeingia instant bila delay yoyote.',
  'Kijana tulia usitoke mapema, target 3x hadi 5x ndio safe.',
  'Naitwa Rose thank you so much Mr Dan nmetoa kwa 50K leo ubarikiwe sana!',
  'Eii plane imeenda 54x! Nani alishika hii round ya moto?',
  'Signals za leo zimecome through fiti sana, niko happy.',
  'Hapa Winbet hakuna delay kwa payout, 2 mins pesa iko kwa M-Pesa 🙌',
  'Tuliza boli cheza na discipline usifuate emotions wakuu.',
  'Room 3 iko moto leo, continuous purple rounds 🔥',
  'Nani ako na stake ya 1000 twende kazi kwa Room 1?',
  'Wakuu cashout at 2.50x ndio safe zone, usikue greedy.',
  'Winbet best platform Kenya hands down 💯',
  'Nimeangukia 12k with stake ndogo ya 300, signal ilisema 4x.',
  'Withdrawal ya 35,000 imeingia chap chap kwa M-Pesa!',
  'Mungu akubariki Mr Dan kwa signals safi sana mtafute ni legit.',
  'Leo ndio ile siku ya kuomoka na Winbet mabro.',
  'Room 1 prediction ilikua accurate 100% leo.',
  'Niko live hapa naona purple odds zikipanda tu.',
  'Leo round 10 zote zimepita 3x, hii ni baraka tupu.',
  'Signal ya saa nane imelipa fiti sana, nimerecover capital.',
  'Chezeni smart wakuu, aviator inataka patience na hesabu.',
  'Winbet engine iko smooth sana, hakuna lagging hata kidogo.',
  'Nimecatch 9.40x kwa Room 2, leo weekend imejipa mapema 💰',
  'Discipline ndio siri hapa, 2x kila round inatosha kabisa.',
  'Wadau signals za telegram ziko accurate leo, nimetoa 28k.',
  'Withdrawal yangu ya 15k imeingia instant bila stress.',
  'Room 2 inapeana ma odds kali sana, check history uone.',
  'Kila mtu anacheza Winbet anajua hapa hakuna delay ya cashout.',
  'Signals zimenisaidia kuelewa graph vizuri sana.',
  'Nimecashout kwa 4.50x nikaacha watu wakilia kwa crash.',
  'Small stakes with high frequency ndio format yangu ya leo.',
  'Winbet mko juu, engine ya spribe iko on point.',
  'Nimepiga 8k na stake ya 200 tu, asante Mr Dan!',
  'Guys remember to set auto cashout at 2.0x to protect your balance.',
  'Nani ako na tips za Room 3? Leo naona inatoa high multipliers.',
  'Kuingia na balance poa ndio unacheza bila pressure.',
  'Mimi niko disciplined, target yangu ya 20k per day nimehit tayari.',
  'Winbet payout speed is unmatched, seconds tu kwa simu.',
  'Bro signals za leo ziko fire 🔥🔥🔥',
  'Nimepata 6.80x kwa first bet ya leo, blessed day!',
  'Always withdraw your profits first, kisha cheza na faida.',
  'Winbet ndio kusema, games zote ziko provably fair.',
  'Mr Dan signals are top tier, amerecover lost funds zote.',
  'Leo niko locked in, signals zikidrop tu naweka stake.',
  'Room 1 imepanda 33x sasa hivi, what a massive flight!',
  'Cashout early, secure the bag, rinse and repeat.',
  'Nimejaribu split betting kwa panel 1 na panel 2, method inawork fiti.',
  'Winbet customer service pia wako fast sana.',
  'Leo niko 4 wins in a row, thanks to the live signals.',
  'Hata na stake ndogo unaeza build balance pole pole.',
  'Nani mwingine amewithdraw leo? Mpesa yangu inasoma safi.',
  'Signals ziko accurate 90%+ hii wiki nzima.',
  'Discipline over emotions always, aviator rules.',
  'Plane imepaa tena 12x, Room 1 is cooking today!',
  'Nimepata 5k with just 250 bob, Winbet is the real deal.',
  'Wakuu chezeni na plan, don’t gamble blindly.',
  'Mr Dan thank you bro, 40k profit in one afternoon!',
  'Winbet room switching is so seamless, nimeona 15x kwa Room 2!',
  'Kaa rada na signal ya 4:30pm inakam na multiplier nzito.',
  'Mimi leo sitoki kwa game hadi nihit 50k target.',
  'Nimecash out 5.20x nikamake 10,400 with 2k stake.',
  'Watu wa Winbet mko safe kabisa, hakuna delayed withdrawals.',
  'Respect the graph, check pink history kabla uweke heavy stake.',
  '24x caught safely! Mpesa alert ting ting 📲',
  'Chezeni na 2.0x auto cashout wakuu, consistency ndio key.',
  'Nani mwingine ako Room 2? Grafu inasoma fiti sana.',
  'Hii round imeenda 78x eish! Nani alibaki ndani?',
  'Nashukuru sana Mr Dan, nimelipa rent ya mwezi na aviator leo 🙏',
  'Deposit ya 2k imekua 26,400 in 30 mins!',
  'Wakuu never chase losses, take a break ukihit target.',
  'Signals za VIP channel ziko 98% win rate leo.',
  'Hapa Winbet hakuna delay ya ku-credit winnings.',
  'Plane imepaa tena! Room 1 inafanya mambo leo ✈️🔥',
  'Nimepata 16.50x na stake ya 500, day made!',
  'Leo ni mwendo wa green tu kwa history yangu.',
  'Follow the signals carefully usiruke round.',
  'M-Pesa balance inasoma vizuri sana baada ya hii session 💰',
  'Nimeeka auto cashout 3.5x imegonga pap!',
  'Watu wa 100 bob msiogope, pole pole ndio mwendo.',
  'Kila mtu anacheza smart leo, continuous wins!',
  'Room 3 has given 3 pinks in the last 10 minutes 🔥',
  'Hii game iko smooth kuliko platforms zingine zote Kenya.',
  'Signals za Mr Dan ndio zimeniokoa baada ya bad run.',
  'Withdrawal processing in 60 seconds flat, incredible 🙌',
  'Nimefika 50k milestone ya leo, sasa naenda zangu.',
  'Always set a daily stop-loss and profit target.',
  'Pink rounds zimejaa kwa table, game is on fire!',
  'Leo niko 7 out of 8 wins, pure discipline.',
  'Winbet is the real king of crash games in KE 👑',
  'Nani ako ready na next signal? Dropping in 2 mins!',
  'Target hit! 10k profit locked and withdrawn 💸',
  'Aviator with fast payout is unmatched.',
  'Patience pays here wakuu, don’t rush every round.',
  'Room 1 taking off again, 10x guaranteed soon!',
  'Nimecashout 4.2x with panel 1 and 8.0x with panel 2!',
  'Split betting strategy is working wonders today 🔥',
  'Signal checked, bet placed, win secured 🚀',
  'Hapa hakuna story ya pending withdrawals, instant payout.',
  'Nimeona 42x ikipaa, what a massive multiplier!',
  'Tukutane VIP session ya jioni wakuu 💪',
  'Respect the signals and manage your bankroll.',
  'Another 15,000 KES straight to my M-Pesa account!',
  'Winbet to the moon 🚀🚀🚀'
];


  // --------------------------------------------------------------------------
  // COMPUTED PROPERTIES
  // --------------------------------------------------------------------------
  public potentialPayout1 = computed(() => {
    const p1 = this.panel1();
    if (!p1.hasActiveBet || p1.hasCashedOut) return 0;
    return parseFloat((p1.placedAmount * this.currentMultiplier()).toFixed(2));
  });

  public potentialPayout2 = computed(() => {
    const p2 = this.panel2();
    if (!p2.hasActiveBet || p2.hasCashedOut) return 0;
    return parseFloat((p2.placedAmount * this.currentMultiplier()).toFixed(2));
  });

  public trackLiveBet(_index: number, bet: LiveBet): string { return bet.id; }

  public displayBetsList = computed(() => {
    const tab = this.activeTab();
    const list = this.liveBets();
    const username = this.currentUser()?.username || 'Player';
    const sortedByStake = [...list].sort((a, b) => b.bet - a.bet);

    if (tab === 'my') {
      return list
        .filter(b => b.player === username || b.isCurrentUser)
        .slice(0, 150);
    }
    if (tab === 'top') {
      return sortedByStake.slice(0, 150);
    }
    // "all" tab: sorted from highest bet placed to lowest bet placed
    return sortedByStake.slice(0, 150);
  });

  public betsCount = computed(() => {
    const tab = this.activeTab();
    const list = this.liveBets();
    const username = this.currentUser()?.username || 'Player';

    if (tab === 'my') {
      return list.filter(b => b.player === username || b.isCurrentUser).length;
    }
    return 4880 + (list.length % 65);
  });

  public get filteredTransactionHistory(): TransactionRecord[] {
    const type = this.transactionHistoryTab();
    return this.transactionHistory.filter(transaction => transaction.type === type);
  }

  // --------------------------------------------------------------------------
  // CANVAS ENGINE INTERNALS
  // --------------------------------------------------------------------------
  private planeAsset: HTMLCanvasElement | null = null;
  private planeBodyAsset: HTMLCanvasElement | null = null;
  private planePropellerAsset: HTMLCanvasElement | null = null;
  private flightProgress = 0; // 0.0 to 1.0
  private planeCrashOffset = { x: 0, y: 0 };
  private planeCrashVelocity = { x: 0, y: 0 };
  // The server is the sole round authority. Keeping this disabled prevents
  // disconnected tabs from inventing their own flight and crash result.
  private readonly allowStandaloneRounds = false;

  constructor() {
    // Effect to reflect balance changes or auto-cashout evaluations
    effect(() => {
      const state = this.gameState();
      const mult = this.currentMultiplier();

      if (state === 'RUNNING') {
        this.evaluateAutoCashouts(mult, this.selectedRoom());
      }
    });
  }

  ngOnInit() {
    if (!verifyPlatformEnvironment()) {
      this.gameLoading.set(false);
      this.connectionLoading.set(true);
      return;
    }
    this.initAuthAndSockets();
    this.seedMockBets();
    this.initUserBetHistory();
    this.seedFallbackChat();
    this.startChatSimulation();
    this.startOnlineCounter();
    // Show loading splash for 3 seconds after login
    this.startupTimers.push(setTimeout(() => this.gameLoading.set(false), 3000));
    // Keep the connection frame visible briefly between the logo loader and board.
    this.startupTimers.push(setTimeout(() => this.connectionLoading.set(false), 4200));
  }

  ngAfterViewInit() {
    if (!verifyPlatformEnvironment()) return;
    this.ngZone.runOutsideAngular(() => {
      this.initCanvas();
      this.startCanvasRenderLoop();
    });
  }

  ngOnDestroy() {
    this.startupTimers.forEach(timer => clearTimeout(timer));
    this.subs.forEach(s => s.unsubscribe());
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
    }
    if (this.bettingIntervalId) clearInterval(this.bettingIntervalId);
    if (this.mockLoopIntervalId) clearInterval(this.mockLoopIntervalId);
    if (this.fakeJoinIntervalId) clearInterval(this.fakeJoinIntervalId);
    if (this.chatSimulationIntervalId) clearTimeout(this.chatSimulationIntervalId);
    if (this.chatOnlineIntervalId) clearInterval(this.chatOnlineIntervalId);
    this.clearDepositCooldownTimer();
    this.cashoutNotificationTimeouts.forEach(timeout => clearTimeout(timeout));
    if (this.resizeObserver) this.resizeObserver.disconnect();
    this.gameSound.stopBackground();
    this.gameSocket.disconnect();
  }

  @HostListener('window:resize')
  onResize() {
    this.resizeCanvas();
  }

  @HostListener('window:offline')
  onNetworkOffline() {
    this.networkOnline.set(false);
    this.offlineNoticeDismissed.set(false);
  }

  @HostListener('window:online')
  onNetworkOnline() {
    this.networkOnline.set(true);
    this.offlineNoticeDismissed.set(false);
  }

  @HostListener('document:visibilitychange')
  onCanvasVisibilityChange() {
    if (document.hidden && this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    } else if (!document.hidden && this.animationFrameId === null) {
      this.canvasRoomId = -1;
      this.flightRenderer?.resume();
      this.ngZone.runOutsideAngular(() => this.startCanvasRenderLoop());
    }
  }

  @HostListener('window:keydown.space', ['$event'])
  handleSpaceKey(event: Event) {
    if (this.visualPreview || this.startupPreview || this.showStartupSplash() || this.connectionLoading() || !this.isConnected()) return;
    const activeEl = document.activeElement;
    if (activeEl && ['INPUT', 'TEXTAREA', 'BUTTON', 'SELECT'].includes(activeEl.tagName)) {
      return;
    }
    event.preventDefault();
    this.triggerDualPanelAction();
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent) {
    this.gameSound.unlock();
    const wrap = document.getElementById('profileDropdownWrap');
    if (wrap && !wrap.contains(event.target as Node)) {
      this.showProfileDropdown.set(false);
    }
    const historyWrap = document.getElementById('roundHistoryDropdownWrap');
    const moreBtn = document.querySelector('.more-ribbon-btn');
    if (historyWrap && !historyWrap.contains(event.target as Node) && !moreBtn?.contains(event.target as Node)) {
      this.showExpandedHistory.set(false);
    }
  }

  // --------------------------------------------------------------------------
  // WEBSOCKET & BACKEND COMMUNICATION
  // --------------------------------------------------------------------------
  private initAuthAndSockets() {
    this.subs.push(
      this.authService.currentUser$.subscribe(u => {
        this.currentUser.set(u);
        if (u) {
          this.userBalance.set(u.balance);
          this.hasCompletedFirstDeposit.set(Number(u.depositCount || 0) > 0 || Number(u.balance || 0) > 0);
          if (u.phone_number && !this.mpesaPhone()) {
            this.mpesaPhone.set((u.phone_number || '').replace(/^(\+?254|0)+/, ''));
          }
        }
      }),
      this.authService.userBalance$.subscribe(b => {
        this.userBalance.set(b);
      }),
      this.gameSocket.isConnected$.subscribe(connected => {
        this.isConnected.set(connected);
      }),
      this.gameSocket.roomStates$.subscribe(roomsData => {
        if (!roomsData) return;
        [1, 2, 3].forEach(id => {
          const rData = roomsData[id];
          if (!rData) return;
          const room = this.getRoom(id);
          if (Array.isArray(rData.history)) room.history.set(rData.history);
          if (Array.isArray(rData.activeBets)) this.replaceRoomLiveBets(id, rData.activeBets);
          if (rData.phase === 'flying') {
            room.gameState.set('RUNNING');
            room.currentMultiplier.set(rData.multiplier || 1.00);
            room.animatedMultiplier.set(rData.multiplier || 1.00);
            room.flyingStartedAt = Number(rData.flyingStartedAt) || Date.now();
            room.flightProgress = Math.min(0.97, Math.max(0, 1 - 1 / Math.pow(Math.max(rData.multiplier || 1, 1), 1.55)));
          } else if (rData.phase === 'crashed') {
            room.gameState.set('CRASHED');
            room.flyingStartedAt = 0;
            const crashPoint = Number(rData.multiplier) || 1.00;
            room.currentMultiplier.set(crashPoint);
            room.animatedMultiplier.set(crashPoint);
            room.finalCrashMultiplier.set(crashPoint);
            room.crashFlightProgress = Math.min(1.08, Math.max(0, 1 - 1 / Math.pow(Math.max(crashPoint, 1), 1.55)));
            room.flightProgress = room.crashFlightProgress;
          } else {
            this.onRoomRoundStart(room, rData.bettingDuration);
          }
        });
      }),
      this.gameSocket.roomTick$.subscribe(data => {
        if (data && data.roomId) {
          this.onRoomMultiplierUpdate(data.roomId, data.multiplier);
        }
      }),
      this.gameSocket.roomPhase$.subscribe(data => {
        if (data && data.roomId) {
          this.onRoomSocketPhaseChange(data.roomId, data.phase, data.durationMs, data.multiplier, data.phaseStartedAt);
        }
      }),
      this.gameSocket.roomCrashed$.subscribe(data => {
        if (data && data.roomId) {
          this.onRoomCrash(data.roomId, data.crashPoint);
        }
      }),
      this.gameSocket.roomHistory$.subscribe(data => {
        if (data && data.roomId && Array.isArray(data.history)) {
          this.getRoom(data.roomId).history.set(data.history);
        }
      }),
      this.gameSocket.roomBets$.subscribe(data => {
        if (data && data.roomId && Array.isArray(data.bets)) {
          this.replaceRoomLiveBets(data.roomId, data.bets);
        }
      }),
      this.gameSocket.chatHistory$.subscribe(messages => {
        if (messages.length > 0) {
          this.chatMessages.set(messages.slice(-120));
          this.scrollChatToLatest();
        }
      }),
      this.gameSocket.chatMessage$.subscribe(message => {
        if (message) {
          const currentUserId = this.currentUser()?.id;
          this.chatMessages.update(messages => {
            const exists = messages.some(m => m.id === message.id || (m.text === message.text && m.userId && currentUserId && String(m.userId) === String(currentUserId) && Math.abs(new Date(m.timestamp).getTime() - new Date(message.timestamp).getTime()) < 4000));
            if (exists) return messages;
            return [...messages, message].slice(-200);
          });
          if (this.chatOpen()) {
            if (this.isUserScrolledUp || this.isUserHoldingChat) {
              this.showNewMessagesPill.set(true);
              this.accumulatedNewMessagesCount.update(c => c + 1);
            } else {
              this.scrollChatToLatest('smooth');
              this.showNewMessagesPill.set(false);
              this.accumulatedNewMessagesCount.set(0);
            }
          }
        }
      }),
      this.gameSocket.chatOnline$.subscribe(count => {
        this.chatOnlineCount.set(count);
      }),
      this.gameSocket.chatError$.subscribe(error => {
        if (error) this.showToast(error.message, true);
      }),
      this.gameSocket.roundState$.subscribe(roundState => {
        if (this.isConnected()) {
          this.onSocketPhaseChange(roundState);
        }
      }),
      this.gameSocket.multiplier$.subscribe(mult => {
        if (this.isConnected() && this.gameState() === 'RUNNING') {
          this.onMultiplierUpdate(mult);
        }
      }),
      this.gameSocket.balance$.subscribe(balance => {
        if (this.isConnected()) {
          this.userBalance.set(balance);
          this.authService.updateBalance(balance);
        }
      }),
      this.gameSocket.walletUpdated$.subscribe(event => {
        if (!event) return;
        if (event.balance !== undefined) {
          this.userBalance.set(event.balance);
          this.authService.updateBalance(event.balance, event.depositCount);
        }
        if (event.depositCount !== undefined || event.balance !== undefined) {
          this.hasCompletedFirstDeposit.set(Number(event.depositCount || 0) > 0 || Number(event.balance ?? this.userBalance()) > 0);
        }
      }),
      this.gameSocket.roundHistory$.subscribe(h => {
        if (h && h.length > 0) this.room1.history.set(h);
      }),
      this.gameSocket.activeBets$.subscribe(bets => {
        if (this.isConnected()) this.replaceRoomLiveBets(1, bets);
      }),
      this.gameSocket.betConfirmed$.subscribe(b => {
        if (b) {
          const panel = this.resolveResponsePanel(b.slot, b.roomId);
          if (panel) this.confirmBet(panel, b.amount, b.roomId);
        }
      }),
      this.gameSocket.cashOutSuccess$.subscribe(c => {
        if (c) {
          const panel = this.resolveResponsePanel(c.slot, c.roomId);
          if (panel) this.confirmCashout(panel, c.multiplier, c.payoutAmount, c.roomId);
          else this.triggerCashoutNotification(c.multiplier, c.payoutAmount, c.slot || 1);
        }
      }),
      this.gameSocket.betPlacedBroadcast$.subscribe(b => {
        if (b) this.addLiveBetBroadcast(b);
      }),
      this.gameSocket.betCashedOutBroadcast$.subscribe(c => {
        if (c) this.updateLiveBetBroadcast(c);
      }),
      this.gameSocket.errorNotification$.subscribe(err => {
        if (err) {
          if (err.slot) {
            this.setPanelPending(err.slot, false, false, err.roomId);
          } else {
            this.clearPendingPanels(err.roomId);
          }
          this.showToast(err.message, true);
        }
      }),
      this.gameSocket.withdrawalNotification$.subscribe(payload => {
        if (payload) {
          this.showWithdrawalNotification(payload);
        }
      }),
      this.gameSocket.transactionsUpdated$.subscribe(event => {
        if (event) {
          this.loadTransactionsHistory();
          if (event.action === 'mpesa_deposit_completed' && this.mpesaStatus() === 'waiting') {
            this.mpesaStatus.set('success');
            this.showToast('💰 M-Pesa deposit confirmed!');
            setTimeout(() => this.showWalletModal.set(false), 2500);
          }
          if (event.action === 'mpesa_deposit_failed' && (this.mpesaStatus() === 'waiting' || this.mpesaStatus() === 'sending')) {
            this.mpesaStatus.set('failed');
            this.mpesaStatusMsg.set('❌ Payment failed or was cancelled.');
          }
        }
      }),
      this.gameSocket.depositsUpdated$.subscribe(event => {
        if (event) {
          this.loadTransactionsHistory();
          if (event.action === 'mpesa_deposit_completed' && this.mpesaStatus() === 'waiting') {
            this.mpesaStatus.set('success');
            this.showToast('💰 M-Pesa deposit confirmed!');
            setTimeout(() => this.showWalletModal.set(false), 2500);
          }
          if (event.action === 'mpesa_deposit_failed' && (this.mpesaStatus() === 'waiting' || this.mpesaStatus() === 'sending')) {
            this.mpesaStatus.set('failed');
            this.mpesaStatusMsg.set('❌ Payment failed or was cancelled.');
          }
        }
      }),
      this.gameSocket.withdrawalsUpdated$.subscribe(event => {
        if (event) this.loadTransactionsHistory();
      }),
      this.gameSocket.userUpdated$.subscribe(event => {
        if (event) this.authService.loadCurrentUser().subscribe();
      })
    );

    const token = this.authService.getToken();
    if (token) {
      this.gameSocket.connect(token);
      this.authService.getWallet().subscribe({
        next: wallet => {
          this.userBalance.set(wallet.balance);
          this.hasCompletedFirstDeposit.set(Number(wallet.depositCount || 0) > 0 || Number(wallet.balance || 0) > 0);
        },
      });
    }

    this.authService.getDepositCooldown().subscribe(res => {
      if (res.inCooldown && res.retryAfterSeconds > 0) {
        this.startDepositCooldown(res.retryAfterSeconds);
      }
    });

    this.authService.getPaymentConfig().subscribe(config => {
      const oldMin = this.minDepositAmount();
      this.minDepositAmount.set(config.minDepositAmount);
      if (config.maxDepositAmount) this.maxDepositAmount.set(config.maxDepositAmount);
      if (!this.depositVal() || this.depositVal() === oldMin || this.depositVal() < config.minDepositAmount) {
        this.depositVal.set(config.minDepositAmount);
      }
    });

    // Listen for server-pushed M-Pesa success & failed events
    this.subs.push(
      this.gameSocket.paymentConfig$.subscribe(config => {
        if (!config?.minDepositAmount) return;
        const oldMin = this.minDepositAmount();
        this.minDepositAmount.set(config.minDepositAmount);
        if (config.maxDepositAmount) this.maxDepositAmount.set(config.maxDepositAmount);
        if (!this.depositVal() || this.depositVal() === oldMin || this.depositVal() < config.minDepositAmount) {
          this.depositVal.set(config.minDepositAmount);
        }
      }),
      this.gameSocket.mpesaSuccess$.subscribe(payload => {
        if (!payload) return;
        console.log(`[${new Date().toISOString()}] [PAYMENT_LOG] Player UI updated: mpesa_success`, payload);
        this.mpesaStatus.set('success');
        this.mpesaReceipt.set(payload.receipt);
        this.mpesaStatusMsg.set(`✅ KES ${payload.amount} deposited! Receipt: ${payload.receipt}`);
        this.userBalance.set(payload.balance);
        this.authService.updateBalance(payload.balance);
        this.showToast(`💰 M-Pesa deposit of KES ${payload.amount} confirmed!`);
        this.loadTransactionsHistory();
        setTimeout(() => this.showWalletModal.set(false), 2500);
      }),
      this.gameSocket.mpesaFailed$.subscribe(payload => {
        if (!payload) return;
        this.mpesaStatus.set('failed');
        this.mpesaStatusMsg.set(`❌ Deposit of KES ${payload.amount} failed or was cancelled (${payload.reason}).`);
        this.showToast(`❌ Payment Failed: ${payload.reason}`, true);
        this.loadTransactionsHistory();
      })
    );
  }

  // --------------------------------------------------------------------------
  // MULTI-ROOM ENGINE STATE MANAGERS (Ligibet Style)
  // --------------------------------------------------------------------------
  public onRoomSocketPhaseChange(roomId: number, phase: GameState | string, durationMs?: number, multiplier?: number, phaseStartedAt?: number) {
    const room = this.getRoom(roomId);
    if (phase === 'betting' || phase === 'WAITING') {
      this.onRoomRoundStart(room, durationMs);
    } else if (phase === 'flying' || phase === 'RUNNING') {
      room.gameState.set('RUNNING');
      room.flyingStartedAt = phaseStartedAt || Date.now();
      room.crashFlightProgress = 0;
      const mult = multiplier || 1.00;
      room.currentMultiplier.set(mult);
      room.animatedMultiplier.set(mult);
      room.flightProgress = Math.min(0.97, Math.max(0, 1 - 1 / Math.pow(Math.max(mult, 1), 1.55)));
      if (this.selectedRoom() === roomId && this.musicEnabled()) {
        this.gameSound.playBackground();
      }
    } else if (phase === 'crashed' || phase === 'CRASHED') {
      this.onRoomCrash(roomId, multiplier || room.currentMultiplier());
    }
  }

  public onRoomRoundStart(room: RoomState, durationMs = 5000) {
    room.gameState.set('WAITING');
    room.currentMultiplier.set(1.00);
    room.animatedMultiplier.set(1.00);
    room.flightProgress = 0;
    room.crashFlightProgress = 0;
    room.flyingStartedAt = 0;

    // A room continues cycling while it is not selected. Reset its panel
    // round-state here as well, so switching into it cannot show stale
    // cash-out/pending UI from a previous round.
    room.panel1.update(p => ({
      ...p,
      hasActiveBet: p.placedAmount > 0,
      isPending: false,
      hasCashedOut: false,
      cashedOutPayout: 0,
      cashedOutMultiplier: 0,
      selectedPreset: null,
      presetTapCount: 0
    }));
    room.panel2.update(p => ({
      ...p,
      hasActiveBet: p.placedAmount > 0,
      isPending: false,
      hasCashedOut: false,
      cashedOutPayout: 0,
      cashedOutMultiplier: 0,
      selectedPreset: null,
      presetTapCount: 0
    }));

    if (this.selectedRoom() === room.id) {
      this.planeCrashOffset = { x: 0, y: 0 };
      this.activateQueuedBet(1, room.id);
      this.activateQueuedBet(2, room.id);
      if (room.panel1().autoBetEnabled && !room.panel1().hasActiveBet && !room.panel1().queuedAmount) {
        setTimeout(() => this.placeBet(1), 120);
      }
      if (room.panel2().autoBetEnabled && !room.panel2().hasActiveBet && !room.panel2().queuedAmount && !this.panel2Collapsed()) {
        setTimeout(() => this.placeBet(2), 120);
      }
    } else {
      // Keep queued bets scoped to the room that is opening. This allows a
      // user to switch rooms without reusing another room's panel state.
      this.activateQueuedBet(1, room.id);
      this.activateQueuedBet(2, room.id);
    }

    this.seedRoomMockBets(room);

    const totalDuration = Math.max(0, durationMs || 5000);
    room.countdownSeconds.set(Math.ceil(totalDuration / 1000));
    room.countdownProgress.set(100);
    const startTime = Date.now();

    if (room.bettingIntervalId) clearInterval(room.bettingIntervalId);
    room.bettingIntervalId = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, totalDuration - elapsed);
      room.countdownSeconds.set(Math.ceil(remaining / 1000));
      const progress = Math.max(0, Math.min(100, (remaining / totalDuration) * 100));
      room.countdownProgress.set(progress);

      if (remaining <= 0) {
        clearInterval(room.bettingIntervalId);
        if (!this.isConnected() && this.allowStandaloneRounds) {
          this.startRoomFlightPhase(room);
        }
      }
    }, 30);
  }

  private startRoomFlightPhase(room: RoomState) {
    room.gameState.set('RUNNING');
    room.flyingStartedAt = Date.now();
    room.currentMultiplier.set(1.00);
    room.animatedMultiplier.set(1.00);
    room.flightProgress = 0;

    if (this.selectedRoom() === room.id && this.musicEnabled()) {
      this.gameSound.playBackground();
    }

    if (this.isConnected()) return;

    const r = Math.random();
    const crashPoint: number = r < 0.03
      ? 1.00
      : parseFloat(Math.max(1.00, Math.min(100000, 0.97 / (1 - r))).toFixed(2));

    const flightStartTime = Date.now();
    if (room.mockLoopIntervalId) clearInterval(room.mockLoopIntervalId);

    room.mockLoopIntervalId = setInterval(() => {
      if (this.isConnected()) {
        clearInterval(room.mockLoopIntervalId);
        return;
      }

      const elapsedSec = (Date.now() - flightStartTime) / 1000;
      const nextMult = parseFloat((1.00 + 0.06 * elapsedSec + 0.01 * Math.pow(elapsedSec, 2)).toFixed(2));

      if (nextMult >= crashPoint) {
        clearInterval(room.mockLoopIntervalId);
        this.onRoomCrash(room.id, crashPoint);
      } else {
        this.onRoomMultiplierUpdate(room.id, nextMult);
      }
    }, 16);
  }

  public onRoomMultiplierUpdate(roomId: number, multiplier: number) {
    const room = this.getRoom(roomId);
    room.currentMultiplier.set(multiplier);

    room.flightProgress = Math.min(0.97, Math.max(0, 1 - 1 / Math.pow(Math.max(multiplier, 1), 1.55)));

    this.simulateRoomAICashouts(room, multiplier);

    // Auto-cashout belongs to the room that produced this tick. It must keep
    // running even when the player is viewing another room.
    this.evaluateAutoCashouts(multiplier, roomId);
  }

  public onRoomCrash(roomId: number, finalPoint: number) {
    const room = this.getRoom(roomId);
    room.gameState.set('CRASHED');
    room.finalCrashMultiplier.set(finalPoint);
    room.currentMultiplier.set(finalPoint);
    room.animatedMultiplier.set(finalPoint);
    room.crashFlightProgress = room.flightProgress;
    room.flightProgress = room.crashFlightProgress;

    room.flyingStartedAt = 0;
    room.panel1.update(p => ({ ...p, placedAmount: 0, isPending: false, hasActiveBet: false }));
    room.panel2.update(p => ({ ...p, placedAmount: 0, isPending: false, hasActiveBet: false }));

    if (this.selectedRoom() === roomId) {
      this.gameSound.stopBackground();
      if (this.soundEnabled() && (typeof document === 'undefined' || !document.hidden)) {
        this.gameSound.playCrash();
      }
    }

    if (!this.isConnected()) {
      room.history.update(h => [finalPoint, ...h.slice(0, 19)]);
      if (this.allowStandaloneRounds) {
        setTimeout(() => this.onRoomRoundStart(room), 1500);
      }
    }
  }

  private seedRoomMockBets(room: RoomState) {
    if (room.fakeJoinIntervalId) clearInterval(room.fakeJoinIntervalId);

    const initialBatch: LiveBet[] = [];
    for (let i = 0; i < 160; i++) {
      initialBatch.push(this.makeFakePlayer(i));
    }
    room.liveBets.set(initialBatch);

    let trickleCount = 0;
    room.fakeJoinIntervalId = setInterval(() => {
      if (trickleCount >= 40 || room.gameState() !== 'WAITING') {
        clearInterval(room.fakeJoinIntervalId);
        return;
      }
      const burst = Math.floor(Math.random() * 4) + 2;
      const newPlayers: LiveBet[] = [];
      for (let j = 0; j < burst && trickleCount < 40; j++, trickleCount++) {
        newPlayers.push(this.makeFakePlayer(160 + trickleCount));
      }
      room.liveBets.update(list => [...newPlayers, ...list].slice(0, this.maxBetFeedSize));
    }, 250);
  }

  private simulateRoomAICashouts(room: RoomState, currentMult: number) {
    room.liveBets.update(bets => {
      let changed = false;
      const next = bets.map(b => {
        if (!b.cashedOut && !b.isCurrentUser) {
          const target = b.targetMultiplier || 2.00;
          if (currentMult >= target) {
            changed = true;
            const mult = parseFloat(target.toFixed(2));
            return {
              ...b,
              multiplier: mult,
              win: parseFloat((b.bet * mult).toFixed(2)),
              cashedOut: true
            };
          }
        }
        return b;
      });
      return changed ? next : bets;
    });
  }

  private replaceRoomLiveBets(roomId: number, bets: SourceGameBet[]) {
    const room = this.getRoom(roomId);
    const currentUserId = String(this.currentUser()?.id ?? '');
    const realBets: LiveBet[] = bets.map((bet, index) => ({
      id: `${bet.odlutUserId || bet.username}-${bet.betId || index}`,
      player: bet.username || 'Player',
      avatarIcon: bet.isBot ? this.FAKE_AVATARS[index % this.FAKE_AVATARS.length] : this.gameAvatar(),
      bet: Number(bet.amount) || 0,
      multiplier: bet.status === 'cashed_out' ? Number(bet.cashoutMultiplier) || null : null,
      win: bet.status === 'cashed_out' ? Number(bet.payout) || 0 : 0,
      cashedOut: bet.status === 'cashed_out',
      isCurrentUser: Boolean(bet.odlutUserId && bet.odlutUserId === currentUserId),
    }));

    if (realBets.length === 0) return;

    room.liveBets.update(existing => {
      const fakeOnly = existing.filter(b => b.id.startsWith('fake-'));
      return [...realBets, ...fakeOnly].slice(0, this.maxBetFeedSize);
    });
  }

  // Legacy single-room wrappers
  public onRoundStart(durationMs = 5000) {
    this.onRoomRoundStart(this.room1, durationMs);
  }

  public onMultiplierUpdate(multiplier: number) {
    this.onRoomMultiplierUpdate(1, multiplier);
  }

  public onCrash(finalPoint: number) {
    this.onRoomCrash(1, finalPoint);
  }

  private onSocketPhaseChange(roundState: { phase: 'betting' | 'flying' | 'crashed'; durationMs?: number; multiplier?: number; phaseStartedAt?: number }) {
    this.onRoomSocketPhaseChange(1, roundState.phase, roundState.durationMs, roundState.multiplier, roundState.phaseStartedAt);
  }

  public toggleSound(): void {
    const enabled = !this.soundEnabled();
    this.gameSound.unlock();
    this.gameSound.setEnabled(enabled);
    this.soundEnabled.set(enabled);
    this.syncAudioWithActiveRoom();
  }

  public gamePreferenceEnabled(id: 'sound' | 'music' | 'animation'): boolean {
    return id === 'sound' ? this.soundEnabled() : id === 'music' ? this.musicEnabled() : this.animationEnabled();
  }

  public toggleGamePreference(id: 'sound' | 'music' | 'animation') {
    if (id === 'sound') this.toggleSound();
    else if (id === 'music') {
      const enabled = !this.musicEnabled();
      this.gameSound.unlock();
      this.gameSound.setMusicEnabled(enabled);
      this.musicEnabled.set(enabled);
      this.syncAudioWithActiveRoom();
    } else {
      this.animationEnabled.update(enabled => !enabled);
      localStorage.setItem('aviator_animation_enabled', String(this.animationEnabled()));
      this.pausedAnimationPose = null;
      if (this.animationEnabled()) this.flightRenderer?.resume();
    }
  }

  public openGameMenuPage(page: GameMenuPage) {
    this.closeProfileDropdown();
    if (page === 'history') { this.openHistoryModal(); return; }
    this.gameMenuPage.set(page);
    if (page === 'limits') {
      this.gameLimitsLoading.set(true);
      this.subs.push(this.authService.getGameLimits().pipe(finalize(() => this.gameLimitsLoading.set(false))).subscribe({
        next: limits => this.gameLimits.set(limits),
        error: () => this.gameLimits.set(null),
      }));
    }
  }

  public chooseGameAvatar(path: string) {
    if (!this.avatarChoices.some(avatar => avatar.path === path)) return;
    this.gameAvatar.set(path);
    localStorage.setItem(`aviator_avatar_${this.currentUser()?.id || 'guest'}`, path);
    this.gameMenuPage.set(null);
  }

  // --------------------------------------------------------------------------
  // PAYOUT & AUTO CASHOUT CALCULATIONS
  // --------------------------------------------------------------------------
  private evaluateAutoCashouts(mult: number, roomId = this.selectedRoom()) {
    const room = this.getRoom(roomId);
    const p1 = room.panel1();
    if (p1.mode === 'auto' && p1.hasActiveBet && !p1.hasCashedOut && mult >= p1.autoTarget) {
      this.cashOut(1, roomId);
    }

    const p2 = room.panel2();
    if (p2.mode === 'auto' && p2.hasActiveBet && !p2.hasCashedOut && mult >= p2.autoTarget) {
      this.cashOut(2, roomId);
    }
  }

  public placeBet(panelIndex: 1 | 2) {
    if (!verifyPlatformEnvironment()) return;
    // Once the plane is in flight, a stake belongs to the following round.
    if (this.gameState() !== 'WAITING') {
      this.queueBet(panelIndex);
      return;
    }

    const panel = panelIndex === 1 ? this.panel1() : this.panel2();
    const amount = panel.amount;

    if (!Number.isFinite(amount) || amount <= 0) {
      this.showToast('Please enter a valid bet amount', true);
      return;
    }

    if (!this.hasCompletedFirstDeposit() && this.userBalance() <= 0) {
      this.showToast('Make at least one deposit to be able to play.', true);
      return;
    }

    if (panel.hasActiveBet || panel.queuedAmount > 0 || panel.isPending) return;

    if (amount > this.userBalance()) {
      this.showToast('Your wallet balance is too low. Use Deposit to add funds.', true);
      return;
    }

    if (this.isConnected()) {
      // The backend owns live balances, bet acceptance, and the admin feed.
      // Do not optimistically mutate any of those values on the client.
      this.setPanelPending(panelIndex, true);
      const autoCashoutTarget = (panel.mode === 'auto' && panel.autoCashoutEnabled && panel.autoTarget && panel.autoTarget >= 1.01) ? panel.autoTarget : undefined;
      this.gameSocket.placeBet(amount, panelIndex, autoCashoutTarget, this.selectedRoom());
      return;
    }

    // Deduct balance
    const newBalance = this.userBalance() - amount;
    this.userBalance.set(newBalance);
    this.authService.updateBalance(newBalance);

    if (panelIndex === 1) {
      this.panel1.update(p => ({
        ...p,
        placedAmount: amount,
        hasActiveBet: true,
        hasCashedOut: false
      }));
    } else {
      this.panel2.update(p => ({
        ...p,
        placedAmount: amount,
        hasActiveBet: true,
        hasCashedOut: false
      }));
    }

    // Add user bet to live sidebar table
    const username = this.currentUser()?.username || 'You';
    const newBetRow: LiveBet = {
      id: Math.random().toString(36).substring(2, 9),
      player: username,
      avatarIcon: this.gameAvatar(),
      bet: amount,
      multiplier: null,
      win: 0,
      cashedOut: false,
      isCurrentUser: true
    };

    this.activeRoom().liveBets.update(list => [newBetRow, ...list]);
  }

  /**
   * Reserve a stake while a round is in flight. It is promoted to an active
   * bet by activateQueuedBet as soon as the next betting phase opens.
   */
  public queueBet(panelIndex: 1 | 2) {
    const panel = panelIndex === 1 ? this.panel1() : this.panel2();
    const amount = panel.amount;

    if (this.gameState() === 'WAITING') {
      this.placeBet(panelIndex);
      return;
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      this.showToast('Please enter a valid bet amount', true);
      return;
    }

    if (!this.hasCompletedFirstDeposit() && this.userBalance() <= 0) {
      this.showToast('Make at least one deposit to be able to play.', true);
      return;
    }

    if (panel.queuedAmount > 0 || panel.isPending) return;

    if (amount > this.userBalance()) {
      this.showToast('Your wallet balance is too low. Use Deposit to add funds.', true);
      return;
    }

    if (this.isConnected()) {
      if (panelIndex === 1) {
        this.panel1.update(p => ({ ...p, queuedAmount: amount }));
      } else {
        this.panel2.update(p => ({ ...p, queuedAmount: amount }));
      }
      return;
    }

    const newBalance = this.userBalance() - amount;
    this.userBalance.set(newBalance);
    this.authService.updateBalance(newBalance);

    if (panelIndex === 1) {
      this.panel1.update(p => ({ ...p, queuedAmount: amount }));
    } else {
      this.panel2.update(p => ({ ...p, queuedAmount: amount }));
    }
  }

  /** Moves a reserved next-round stake into the current betting phase. */
  public activateQueuedBet(panelIndex: 1 | 2, roomId = this.selectedRoom()) {
    const room = this.getRoom(roomId);
    const panel = panelIndex === 1 ? room.panel1() : room.panel2();
    const queuedAmount = panel.queuedAmount;

    if (queuedAmount <= 0) return;

    if (this.isConnected()) {
      this.setPanelPending(panelIndex, true, true, roomId);
      this.gameSocket.placeBet(
        queuedAmount,
        panelIndex,
        panel.mode === 'auto' ? panel.autoTarget : undefined,
        roomId
      );
      return;
    }

    const activate = (p: PanelBetState): PanelBetState => ({
      ...p,
      placedAmount: queuedAmount,
      queuedAmount: 0,
      hasActiveBet: true,
      hasCashedOut: false,
      cashedOutPayout: 0,
      cashedOutMultiplier: 0
    });

    if (panelIndex === 1) {
      room.panel1.update(activate);
    } else {
      room.panel2.update(activate);
    }

  }

  public cancelQueuedBet(panelIndex: 1 | 2) {
    const panel = panelIndex === 1 ? this.panel1() : this.panel2();
    if (panel.queuedAmount <= 0) return;

    if (!this.isConnected()) {
      const refunded = this.userBalance() + panel.queuedAmount;
      this.userBalance.set(refunded);
      this.authService.updateBalance(refunded);
    }

    if (panelIndex === 1) {
      this.panel1.update(p => ({ ...p, queuedAmount: 0 }));
    } else {
      this.panel2.update(p => ({ ...p, queuedAmount: 0 }));
    }

    this.showToast('Next-round bet cancelled');
  }

  public cancelBet(panelIndex: 1 | 2) {
    const panel = panelIndex === 1 ? this.panel1() : this.panel2();
    if (this.gameState() !== 'WAITING' || !panel.hasActiveBet) return;

    if (this.isConnected()) {
      this.showToast('A live bet cannot be cancelled after the server confirms it.', true);
      return;
    }

    // Refund balance
    const refunded = this.userBalance() + panel.placedAmount;
    this.userBalance.set(refunded);
    this.authService.updateBalance(refunded);

    if (panelIndex === 1) {
      this.panel1.update(p => ({ ...p, hasActiveBet: false, placedAmount: 0 }));
    } else {
      this.panel2.update(p => ({ ...p, hasActiveBet: false, placedAmount: 0 }));
    }

    this.showToast('Bet cancelled');
  }

  public cashOut(panelIndex: 1 | 2, roomId = this.selectedRoom()) {
    if (!verifyPlatformEnvironment()) return;
    const room = this.getRoom(roomId);
    const mult = room.currentMultiplier();
    const panel = panelIndex === 1 ? room.panel1() : room.panel2();

    if (room.gameState() !== 'RUNNING' || !panel.hasActiveBet || panel.hasCashedOut || panel.isPending) return;

    if (this.isConnected()) {
      this.setPanelPending(panelIndex, true, false, roomId);
      this.gameSocket.cashOut(panelIndex, roomId);
      return;
    }

    const payout = parseFloat((panel.placedAmount * mult).toFixed(2));

    // Credit win to wallet balance
    const updatedBalance = this.userBalance() + payout;
    this.userBalance.set(updatedBalance);
    this.authService.updateBalance(updatedBalance);

    if (panelIndex === 1) {
      room.panel1.update(p => ({
        ...p,
        hasCashedOut: true,
        cashedOutPayout: payout,
        cashedOutMultiplier: mult
      }));
    } else {
      room.panel2.update(p => ({
        ...p,
        hasCashedOut: true,
        cashedOutPayout: payout,
        cashedOutMultiplier: mult
      }));
    }

    // Highlight user row in "All Bets" table
    const username = this.currentUser()?.username || 'You';
    room.liveBets.update(list =>
      list.map(b => {
        if (b.player === username || b.isCurrentUser) {
          return {
            ...b,
            multiplier: mult,
            win: payout,
            cashedOut: true
          };
        }
        return b;
      })
    );

    this.triggerCashoutNotification(mult, payout, panelIndex);
    // Cashout notification banner at top of canvas is displayed above
  }

  private setPanelPending(panelIndex: 1 | 2, isPending: boolean, clearQueued = false, roomId = this.selectedRoom()) {
    const room = this.getRoom(roomId);
    const apply = (panel: PanelBetState): PanelBetState => ({
      ...panel,
      isPending,
      queuedAmount: clearQueued ? 0 : panel.queuedAmount
    });

    if (panelIndex === 1) {
      room.panel1.update(apply);
    } else {
      room.panel2.update(apply);
    }
  }

  /** Supports a backend restart rolling out the two-panel protocol. */
  private resolveResponsePanel(slot?: 1 | 2, roomId = this.selectedRoom()): 1 | 2 | null {
    const room = this.getRoom(roomId);
    if (slot === 1 || slot === 2) return slot;
    if (room.panel1().isPending) return 1;
    if (room.panel2().isPending) return 2;
    return null;
  }

  private clearPendingPanels(roomId = this.selectedRoom()) {
    this.setPanelPending(1, false, false, roomId);
    this.setPanelPending(2, false, false, roomId);
  }

  private confirmBet(panelIndex: 1 | 2, amount: number, roomId = this.selectedRoom()) {
    const room = this.getRoom(roomId);
    const apply = (panel: PanelBetState): PanelBetState => ({
      ...panel,
      placedAmount: amount,
      queuedAmount: 0,
      isPending: false,
      hasActiveBet: true,
      hasCashedOut: false,
      cashedOutPayout: 0,
      cashedOutMultiplier: 0
    });

    if (panelIndex === 1) {
      room.panel1.update(apply);
    } else {
      room.panel2.update(apply);
    }
  }

  private confirmCashout(panelIndex: 1 | 2, multiplier: number, payout: number, roomId = this.selectedRoom()) {
    const room = this.getRoom(roomId);
    const apply = (panel: PanelBetState): PanelBetState => ({
      ...panel,
      isPending: false,
      hasCashedOut: true,
      cashedOutPayout: payout,
      cashedOutMultiplier: multiplier
    });

    if (panelIndex === 1) {
      room.panel1.update(apply);
    } else {
      room.panel2.update(apply);
    }

    const p = panelIndex === 1 ? room.panel1() : room.panel2();
    const placedAmount = p.placedAmount || p.amount || 10;
    this.recordUserBetHistory(placedAmount, multiplier, payout, true);
    this.triggerCashoutNotification(multiplier, payout, panelIndex);
  }

  public triggerCashoutNotification(multiplier: number, payout: number, slot: 1 | 2 = 1) {
    const id = ++this.cashoutNotificationSequence;
    this.cashoutNotifications.update(notifications => [...notifications, { id, multiplier, payout, slot }].slice(-2));
    const timeout = setTimeout(() => {
      this.dismissCashoutNotification(id);
      this.cashoutNotificationTimeouts = this.cashoutNotificationTimeouts.filter(value => value !== timeout);
    }, 3600);
    this.cashoutNotificationTimeouts.push(timeout);
  }

  public dismissCashoutNotification(id: number): void {
    this.cashoutNotifications.update(notifications => notifications.filter(notification => notification.id !== id));
  }

  public showWithdrawalNotification(payload: { id?: number; title?: string; message: string; type?: string; timestamp?: string; createdAt?: string }) {
    if (payload.id && payload.id === this.lastWithdrawalNotificationId) return;
    if (this.withdrawalNotifTimeout) clearTimeout(this.withdrawalNotifTimeout);
    if (payload.id) this.lastWithdrawalNotificationId = payload.id;

    const createdAt = payload.createdAt || payload.timestamp;
    const timestamp = createdAt
      ? new Date(createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    this.withdrawalNotif.set({
      id: payload.id,
      title: payload.title || '📋 Winbet Notification',
      message: payload.message,
      type: payload.type || 'info',
      timestamp
    });
    // Auto-dismiss after 6 seconds so the player can read the admin-edited message
    this.withdrawalNotifTimeout = setTimeout(() => {
      this.withdrawalNotif.set(null);
    }, 6000);
  }

  public dismissWithdrawalNotification() {
    if (this.withdrawalNotifTimeout) clearTimeout(this.withdrawalNotifTimeout);
    this.withdrawalNotif.set(null);
  }

  public claimWelcomeBonus() {
    if (this.isClaimingBonus() || this.currentUser()?.bonus_claimed) return;

    if (!this.hasCompletedFirstDeposit()) {
      this.showBonusNotification('Bonus unavailable', 'Make at least one deposit to be able to claim the bonus.', 'info');
      return;
    }

    this.isClaimingBonus.set(true);
    this.authService.claimWelcomeBonus().subscribe({
      next: response => {
        this.userBalance.set(response.balance);
        this.showProfileDropdown.set(false);
        this.showBonusNotification('Bonus claimed!', '3,500 KES has been added to your wallet.', 'success');
        this.isClaimingBonus.set(false);
        this.loadTransactionsHistory();
      },
      error: message => {
        this.showBonusNotification('Bonus unavailable', message, 'info');
        this.isClaimingBonus.set(false);
      }
    });
  }

  public showBonusNotification(title: string, message: string, type: 'success' | 'info') {
    if (this.bonusNotifTimeout) clearTimeout(this.bonusNotifTimeout);
    this.bonusNotif.set({ title, message, type });
    this.bonusNotifTimeout = setTimeout(() => this.bonusNotif.set(null), 6500);
  }

  public dismissBonusNotification() {
    if (this.bonusNotifTimeout) clearTimeout(this.bonusNotifTimeout);
    this.bonusNotif.set(null);
  }

  public triggerDualPanelAction() {
    if (!verifyPlatformEnvironment()) return;
    const state = this.gameState();
    if (state === 'WAITING') {
      if (!this.panel1().hasActiveBet && !this.panel1().queuedAmount && !this.panel1().isPending) {
        this.placeBet(1);
      }
      if (!this.panel2().hasActiveBet && !this.panel2().queuedAmount && !this.panel2().isPending) {
        this.placeBet(2);
      }
    } else if (state === 'RUNNING') {
      if (this.panel1().hasActiveBet && !this.panel1().hasCashedOut && !this.panel1().isPending) {
        this.cashOut(1);
      }
      if (this.panel2().hasActiveBet && !this.panel2().hasCashedOut && !this.panel2().isPending) {
        this.cashOut(2);
      }
    }
  }

  // --------------------------------------------------------------------------
  // SIDEBAR MOCK BETS FEED  (frontend-only — never touches backend / admin)
  // --------------------------------------------------------------------------

  /** Masked player formats matching official Aviator format: 2***9, 2***6, 0***3, etc. */
  private readonly FAKE_PREFIX_DIGITS = ['2', '2', '2', '2', '7', '1', '0', '2', '2', '7'];

  private readonly FAKE_AVATARS = REFERENCE_AVATARS.map(avatar => avatar.path);

  /** Common stake amounts used by the simulated live feed. */
  private readonly FAKE_BET_POOL = [
    20, 50, 50, 100, 100, 100, 100, 150, 150,
    200, 200, 200, 250, 300, 350, 500, 500, 600,
    850, 1000, 1000, 1200, 1450, 1500, 2000
  ];

  /**
   * Large stakes are deliberately uncommon.  This keeps the high-stake end of
   * the sorted feed varied instead of filling it with repeated 10,000 KES rows.
   */
  private generateFakeBetAmount(): number {
    const roll = Math.random();
    if (roll < 0.012) return 10000;
    if (roll < 0.045) return [6000, 7000, 8000][Math.floor(Math.random() * 3)];
    if (roll < 0.16) return [2500, 3000, 3500, 3750, 4000, 5000][Math.floor(Math.random() * 6)];
    return this.FAKE_BET_POOL[Math.floor(Math.random() * this.FAKE_BET_POOL.length)];
  }

  private generateRealisticCashoutTarget(betAmount: number): number {
    const roll = Math.random();
    if (betAmount >= 2000) {
      // Bigger players are mixed risk-takers, not a near-uniform stream of
      // early cash-outs.  Most still protect their stake, while a meaningful
      // share stays in through medium and high multipliers.
      if (roll < 0.26) return parseFloat((1.20 + Math.random() * 0.75).toFixed(2));
      if (roll < 0.62) return parseFloat((2.00 + Math.random() * 2.50).toFixed(2));
      if (roll < 0.86) return parseFloat((4.60 + Math.random() * 5.40).toFixed(2));
      if (roll < 0.96) return parseFloat((10.25 + Math.random() * 14.75).toFixed(2));
      return parseFloat((25.50 + Math.random() * 34.50).toFixed(2));
    }

    if (roll < 0.30) return parseFloat((1.15 + Math.random() * 0.85).toFixed(2));
    if (roll < 0.66) return parseFloat((2.00 + Math.random() * 2.70).toFixed(2));
    if (roll < 0.88) return parseFloat((4.75 + Math.random() * 6.25).toFixed(2));
    if (roll < 0.97) return parseFloat((11.25 + Math.random() * 18.75).toFixed(2));
    return parseFloat((30.25 + Math.random() * 49.75).toFixed(2));
  }

  private makeFakePlayer(index: number): LiveBet {
    const startDigit = this.FAKE_PREFIX_DIGITS[index % this.FAKE_PREFIX_DIGITS.length];
    const endDigit = Math.floor(Math.random() * 10);
    const bet = this.generateFakeBetAmount();
    return {
      id: `fake-${index}-${Date.now()}`,
      player: `${startDigit}***${endDigit}`,
      avatarIcon: this.FAKE_AVATARS[index % this.FAKE_AVATARS.length],
      bet,
      multiplier: null,
      win: 0,
      cashedOut: false,
      targetMultiplier: this.generateRealisticCashoutTarget(bet)
    };
  }

  private seedMockBets() {
    if (this.fakeJoinIntervalId) clearInterval(this.fakeJoinIntervalId);

    const initialBatch: LiveBet[] = [];
    for (let i = 0; i < 160; i++) {
      initialBatch.push(this.makeFakePlayer(i));
    }
    this.activeRoom().liveBets.set(initialBatch);

    let trickleCount = 0;
    this.fakeJoinIntervalId = setInterval(() => {
      if (trickleCount >= 40 || this.gameState() !== 'WAITING') {
        clearInterval(this.fakeJoinIntervalId);
        return;
      }
      const burst = Math.floor(Math.random() * 4) + 2;
      const newPlayers: LiveBet[] = [];
      for (let j = 0; j < burst && trickleCount < 40; j++, trickleCount++) {
        newPlayers.push(this.makeFakePlayer(160 + trickleCount));
      }
      this.activeRoom().liveBets.update(list => [...newPlayers, ...list].slice(0, this.maxBetFeedSize));
    }, 250);
  }

  private simulateAICashouts(currentMult: number) {
    this.activeRoom().liveBets.update(bets =>
      bets.map(b => {
        if (!b.cashedOut && !b.isCurrentUser) {
          const target = b.targetMultiplier || 2.00;
          if (currentMult >= target) {
            const mult = parseFloat(target.toFixed(2));
            return {
              ...b,
              multiplier: mult,
              win: parseFloat((b.bet * mult).toFixed(2)),
              cashedOut: true
            };
          }
        }
        return b;
      })
    );
  }

  private addLiveBetBroadcast(b: LiveBetBroadcast) {
    const row: LiveBet = {
      id: b.betId ? `bet-${b.betId}` : Math.random().toString(),
      player: b.player,
      avatarIcon: this.gameAvatar(),
      bet: b.bet,
      multiplier: b.multiplier,
      win: b.win,
      cashedOut: b.cashedOut,
      isCurrentUser: b.userId === this.currentUser()?.id
    };
    this.activeRoom().liveBets.update(list => [row, ...list].slice(0, this.maxBetFeedSize));
  }

  private updateLiveBetBroadcast(c: LiveBetBroadcast) {
    this.activeRoom().liveBets.update(list =>
      list.map(item => {
        const isMatchingBet = c.betId
          ? item.id === `bet-${c.betId}`
          : item.player === c.player;
        if (isMatchingBet) {
          return {
            ...item,
            multiplier: c.multiplier,
            win: c.win,
            cashedOut: true
          };
        }
        return item;
      })
    );
  }

  private replaceLiveBets(bets: SourceGameBet[]) {
    const currentUserId = String(this.currentUser()?.id ?? '');
    const realBets: LiveBet[] = bets.map((bet, index) => ({
      id: `${bet.odlutUserId || bet.username}-${bet.betId || index}`,
      player: bet.username || 'Player',
      avatarIcon: bet.isBot ? this.FAKE_AVATARS[index % this.FAKE_AVATARS.length] : this.gameAvatar(),
      bet: Number(bet.amount) || 0,
      multiplier: bet.status === 'cashed_out' ? Number(bet.cashoutMultiplier) || null : null,
      win: bet.status === 'cashed_out' ? Number(bet.payout) || 0 : 0,
      cashedOut: bet.status === 'cashed_out',
      isCurrentUser: Boolean(bet.odlutUserId && bet.odlutUserId === currentUserId),
    }));

    if (realBets.length === 0) return;

    this.activeRoom().liveBets.update(existing => {
      const fakeOnly = existing.filter(b => b.id.startsWith('fake-'));
      return [...realBets, ...fakeOnly].slice(0, this.maxBetFeedSize);
    });
  }

  // --------------------------------------------------------------------------
  // HTML5 CANVAS RENDERING ENGINE (60 FPS Exponential Trajectory & Effects)
  // --------------------------------------------------------------------------
  private initCanvas() {
    if (!this.canvasRef) return;
    const canvas = this.canvasRef.nativeElement;
    this.flightRenderer = new AviatorFlightRenderer(canvas);
    this.resizeCanvas();

    // Use ResizeObserver to re-size canvas whenever container dimensions change
    if (this.canvasContainerRef) {
      this.resizeObserver = new ResizeObserver(() => {
        this.resizeCanvas();
      });
      this.resizeObserver.observe(this.canvasContainerRef.nativeElement);
    }

    this.loadPlaneAsset();
  }

  private loadPlaneAsset() {
    const load = (name: string, store: (asset: HTMLCanvasElement) => void) => {
      const image = new Image();
      image.onload = () => {
        const asset = document.createElement('canvas');
        asset.width = image.naturalWidth;
        asset.height = image.naturalHeight;
        const context = asset.getContext('2d');
        if (!context) return;
        context.drawImage(image, 0, 0);
        store(asset);
        if (this.planeAsset) this.flightRenderer?.setSprite(this.planeAsset, this.planeBodyAsset, this.planePropellerAsset);
      };
      image.src = `assets/images/${name}.svg`;
    };
    load('aviator-plane', asset => this.planeAsset = asset);
    load('aviator-plane-body', asset => this.planeBodyAsset = asset);
    load('aviator-plane-propeller', asset => this.planePropellerAsset = asset);
  }

  private resizeCanvas() {
    if (!this.canvasRef || !this.canvasContainerRef) return;
    const canvas = this.canvasRef.nativeElement;
    if (!this.flightRenderer || this.flightRenderer.canvas !== canvas) {
      this.flightRenderer = new AviatorFlightRenderer(canvas);
      if (this.planeAsset) this.flightRenderer.setSprite(this.planeAsset, this.planeBodyAsset, this.planePropellerAsset);
    }
    const container = this.canvasContainerRef.nativeElement;
    if (container.clientWidth && container.clientHeight) {
      this.flightRenderer.resize(container.clientWidth, container.clientHeight, window.devicePixelRatio, window.innerWidth <= 900);
    }
  }

  private startCanvasRenderLoop = (timestamp = performance.now()) => {
    this.animationFrameId = null;
    if (document.hidden || !verifyPlatformEnvironment()) return;
    // Follow the display's frame clock, including 90/120/144Hz laptop screens.
    // A fixed 15ms gate produced uneven cadence and only ~48fps at 144Hz.
    this.renderFrame(timestamp);
    this.animationFrameId = requestAnimationFrame(this.startCanvasRenderLoop);
  };

  private renderFrame(now: number) {
    // The opaque startup frame covers the board, so avoid hidden canvas work.
    if (this.showStartupSplash() || this.startupPreview === 'connection' || this.connectionLoading() || !this.isConnected()) return;
    if (!this.canvasRef) return;
    if (!this.flightRenderer || this.flightRenderer.canvas !== this.canvasRef.nativeElement) this.resizeCanvas();
    if (!this.flightRenderer) return;
    const room = this.activeRoom();
    const state = this.visualGameState();
    if (room.id !== this.flightClockRoomId || room.flyingStartedAt !== this.flightClockServerStart) {
      this.flightClockRoomId = room.id;
      this.flightClockServerStart = room.flyingStartedAt;
      this.flightClockAnchor = now;
      this.flightClockAge = room.flyingStartedAt ? Math.max(0, Date.now() - room.flyingStartedAt) : 0;
    }
    let mult = this.previewMultiplier ?? this.currentMultiplier();
    if (this.visualPreview === 'crashed') mult = 1.67;
    else if (this.visualPreview === 'waiting') mult = 1;
    else if (this.takeoffPreview) mult = 1;
    else if (!this.visualPreview) mult = this.updateAnimatedMultiplier(mult, state, now);

    let poseMultiplier = mult;
    if (!this.animationEnabled()) {
      if (!this.pausedAnimationPose || this.pausedAnimationPose.roomId !== room.id || this.pausedAnimationPose.phase !== state) {
        this.pausedAnimationPose = { roomId: room.id, phase: state, multiplier: mult };
      }
      poseMultiplier = this.pausedAnimationPose.multiplier;
    } else this.pausedAnimationPose = null;
    this.flightRenderer.render({
      phase: state, multiplier: poseMultiplier, roomId: room.id,
      themeMultiplier: mult,
      takeoff: this.takeoffPreview,
      frozen: Boolean(this.visualPreview) || !this.animationEnabled(),
      animate: this.animationEnabled(),
      // Anchor to the engine once; use the monotonic display clock between frames.
      flightElapsedMs: room.flyingStartedAt ? this.flightClockAge + Math.max(0, now - this.flightClockAnchor) : undefined,
    }, now);
  }

  private updateAnimatedMultiplier(target: number, state: GameState, now: number): number {
    const roomId = this.selectedRoom();
    const amount = Number.isFinite(target) ? target : 1;
    const elapsed = Math.min(64, Math.max(0, now - this.lastMultiplierFrameAt));
    this.lastMultiplierFrameAt = now;
    const startingFlight = this.canvasPhase !== 'RUNNING' && state === 'RUNNING';
    if (roomId !== this.canvasRoomId || state !== 'RUNNING' || startingFlight) {
      this.canvasRoomId = roomId;
      this.renderedMultiplierValue = amount;
    } else {
      this.renderedMultiplierValue += (amount - this.renderedMultiplierValue) * (1 - Math.exp(-12 * elapsed / 1000));
    }
    this.canvasPhase = state;
    // Numbers need hundredths at the server's tick rate. The aircraft remains
    // interpolated every frame without rechecking the whole Angular view.
    if (now - this.lastMultiplierPublishAt >= 80 || state !== 'RUNNING' || startingFlight) {
      this.activeRoom().animatedMultiplier.set(Number(this.renderedMultiplierValue.toFixed(2)));
      this.lastMultiplierPublishAt = now;
    }
    return this.renderedMultiplierValue;
  }

  // --------------------------------------------------------------------------
  // USER ACTION HANDLERS & MODALS
  // --------------------------------------------------------------------------
  public isEditingPanel1 = false;
  public isEditingPanel2 = false;
  public panel1InputText = '';
  public panel2InputText = '';

  /** Returns formatted amount when resting, or the raw text while the user is actively typing. */
  public getPanelAmountDisplay(panelIndex: 1 | 2): string {
    if (panelIndex === 1) {
      if (this.isEditingPanel1) {
        return this.panel1InputText;
      }
      return this.panel1().amount.toFixed(2);
    } else {
      if (this.isEditingPanel2) {
        return this.panel2InputText;
      }
      return this.panel2().amount.toFixed(2);
    }
  }

  /** When the user focuses the amount box, present an unformatted integer/number and auto-select all text. */
  public onAmountFocus(panelIndex: 1 | 2, event: Event) {
    const target = event.target as HTMLInputElement;
    const panel = panelIndex === 1 ? this.panel1() : this.panel2();
    const amt = panel.amount;
    // Show clean number without decimal places if whole number (e.g. "10" instead of "10.00")
    const cleanText = amt % 1 === 0 ? amt.toFixed(0) : amt.toString();
    if (panelIndex === 1) {
      this.isEditingPanel1 = true;
      this.panel1InputText = cleanText;
    } else {
      this.isEditingPanel2 = true;
      this.panel2InputText = cleanText;
    }
    target.value = cleanText;
    setTimeout(() => {
      try {
        target.select();
      } catch (_) {}
    }, 0);
  }

  public onAmountInput(panelIndex: 1 | 2, event: Event) {
    const target = event.target as HTMLInputElement;
    // Allow digits and at most one decimal point with max 2 decimal places
    let raw = target.value.replace(/[^0-9.]/g, '');
    const dotIndex = raw.indexOf('.');
    if (dotIndex !== -1) {
      const intPart = raw.substring(0, dotIndex);
      const decPart = raw.substring(dotIndex + 1).replace(/\./g, '').substring(0, 2);
      raw = intPart + '.' + decPart;
    }
    target.value = raw;

    if (panelIndex === 1) {
      this.panel1InputText = raw;
      const val = parseFloat(raw);
      if (!isNaN(val) && val > 0) {
        this.panel1.update(p => ({ ...p, amount: val, selectedPreset: null }));
      }
    } else {
      this.panel2InputText = raw;
      const val = parseFloat(raw);
      if (!isNaN(val) && val > 0) {
        this.panel2.update(p => ({ ...p, amount: val, selectedPreset: null }));
      }
    }
  }

  public onAmountBlur(panelIndex: 1 | 2, event: Event) {
    const target = event.target as HTMLInputElement;
    const panel = panelIndex === 1 ? this.panel1() : this.panel2();
    let val = parseFloat(target.value);
    if (isNaN(val) || val < 1) {
      val = Math.max(1, panel.amount || 10);
    }
    val = Math.min(val, 300000);
    val = Math.round(val * 100) / 100;

    if (panelIndex === 1) {
      this.isEditingPanel1 = false;
      this.panel1InputText = '';
      this.panel1.update(p => ({ ...p, amount: val, selectedPreset: null }));
    } else {
      this.isEditingPanel2 = false;
      this.panel2InputText = '';
      this.panel2.update(p => ({ ...p, amount: val, selectedPreset: null }));
    }
    target.value = val.toFixed(2);
  }

  public setPanelAmount(panelIndex: 1 | 2, value: any) {
    if (panelIndex === 1) {
      this.isEditingPanel1 = false;
      this.panel1InputText = '';
    } else {
      this.isEditingPanel2 = false;
      this.panel2InputText = '';
    }
    const num = parseFloat(value);
    if (!isNaN(num) && num > 0) {
      if (panelIndex === 1) {
        this.panel1.update(p => ({ ...p, amount: num, selectedPreset: null }));
      } else {
        this.panel2.update(p => ({ ...p, amount: num, selectedPreset: null }));
      }
    }
  }

  public adjustPanelAmount(panelIndex: 1 | 2, delta: number) {
    if (panelIndex === 1) {
      this.isEditingPanel1 = false;
      this.panel1InputText = '';
    } else {
      this.isEditingPanel2 = false;
      this.panel2InputText = '';
    }
    const updateAmount = (panel: PanelBetState): PanelBetState => ({
      ...panel,
      amount: Math.max(1, Math.round((panel.amount + delta) * 100) / 100),
      selectedPreset: null,
      presetTapCount: 0
    });

    if (panelIndex === 1) {
      this.panel1.update(updateAmount);
    } else {
      this.panel2.update(updateAmount);
    }
  }

  /** Repeated taps of one preset set its stake to preset × tap count. */
  public selectPresetAmount(panelIndex: 1 | 2, preset: number) {
    if (panelIndex === 1) {
      this.isEditingPanel1 = false;
      this.panel1InputText = '';
    } else {
      this.isEditingPanel2 = false;
      this.panel2InputText = '';
    }
    const updatePreset = (panel: PanelBetState): PanelBetState => {
      const presetTapCount = panel.selectedPreset === preset ? panel.presetTapCount + 1 : 1;
      return {
        ...panel,
        amount: preset * presetTapCount,
        selectedPreset: preset,
        presetTapCount
      };
    };

    if (panelIndex === 1) {
      this.panel1.update(updatePreset);
    } else {
      this.panel2.update(updatePreset);
    }
  }

  public setPanelMode(panelIndex: 1 | 2, mode: 'bet' | 'auto') {
    if (panelIndex === 1) {
      this.panel1.update(p => ({ ...p, mode }));
    } else {
      this.panel2.update(p => ({ ...p, mode }));
    }
  }

  public setAutoCashout(panelIndex: 1 | 2, value: number) {
    const autoTarget = Math.max(1.10, Number(value) || 1.10);
    if (panelIndex === 1) {
      this.panel1.update(p => ({ ...p, autoTarget }));
    } else {
      this.panel2.update(p => ({ ...p, autoTarget }));
    }
  }

  private readonly chatAvatarPool = REFERENCE_AVATARS.map(avatar => avatar.path);
  private readonly chatNamePool = [
  '2***5', '2***1', '2***7', '2***4', '2***9', '2***3', '2***8', '2***6', '2***2', '2***0',
  '071***28', '072***91', '079***45', '070***63', '074***19', '075***82', '076***34', '078***50',
  '2547***12', '2547***99', '2547***34', '2547***88', '2547***56', '2547***71', '2547***03',
  'd***n', 'k***o', 'm***a', 'j***2', 'w***4', 'b***9', 'e***7', 'p***1', 'v***x', 's***8',
  'r***5', 'c***0', 'g***3', 't***6', 'h***8', 'l***2', 'n***9', 'y***4', 'a***1', 'f***7'
];

  private seedFallbackChat() {
    const now = Date.now();
    const initialCount = 35;
    const initialMessages: ChatMessage[] = [];
    for (let i = 0; i < initialCount; i++) {
      const textIndex = i % this.chatFallbackMessages.length;
      const nameIndex = i % this.chatNamePool.length;
      const avatarIndex = i % this.chatAvatarPool.length;
      initialMessages.push({
        id: `initial-chat-${i}`,
        username: this.chatNamePool[nameIndex],
        text: this.chatFallbackMessages[textIndex],
        timestamp: new Date(now - ((initialCount - i) * 6_500)).toISOString(),
        avatar: this.chatAvatarPool[avatarIndex],
        likes: (i * 3) % 7,
        isBot: true,
      });
    }
    this.chatMessages.set(initialMessages);
  }

  private startChatSimulation() {
    if (this.chatSimulationIntervalId) clearTimeout(this.chatSimulationIntervalId);
    
    const scheduleNext = () => {
      // Rapid, continuous Betika-style chat cadence (900ms - 2200ms)
      const delay = 900 + Math.floor(Math.random() * 1300);
      this.chatSimulationIntervalId = setTimeout(() => {
        const textIndex = Math.floor(Math.random() * this.chatFallbackMessages.length);
        const nameIndex = Math.floor(Math.random() * this.chatNamePool.length);
        const avatarIndex = Math.floor(Math.random() * this.chatAvatarPool.length);
        const newMsg: ChatMessage = {
          id: `sim-chat-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          username: this.chatNamePool[nameIndex],
          text: this.chatFallbackMessages[textIndex],
          timestamp: new Date().toISOString(),
          avatar: this.chatAvatarPool[avatarIndex],
          likes: Math.floor(Math.random() * 4),
          isBot: true,
        };

        this.chatMessages.update(list => {
          const next = [...list, newMsg];
          return next.slice(-200);
        });

        if (this.chatOpen()) {
          if (this.isUserScrolledUp || this.isUserHoldingChat) {
            this.showNewMessagesPill.set(true);
            this.accumulatedNewMessagesCount.update(c => c + 1);
          } else {
            this.scrollChatToLatest('smooth');
            this.showNewMessagesPill.set(false);
            this.accumulatedNewMessagesCount.set(0);
          }
        }

        // Occasional double-message burst like a real active sports betting chat
        if (Math.random() < 0.28) {
          setTimeout(() => {
            const burstTextIdx = Math.floor(Math.random() * this.chatFallbackMessages.length);
            const burstNameIdx = Math.floor(Math.random() * this.chatNamePool.length);
            const burstAvatarIdx = Math.floor(Math.random() * this.chatAvatarPool.length);
            const burstMsg: ChatMessage = {
              id: `sim-chat-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
              username: this.chatNamePool[burstNameIdx],
              text: this.chatFallbackMessages[burstTextIdx],
              timestamp: new Date().toISOString(),
              avatar: this.chatAvatarPool[burstAvatarIdx],
              likes: Math.floor(Math.random() * 3),
              isBot: true,
            };
            this.chatMessages.update(list => [...list, burstMsg].slice(-200));
            if (this.chatOpen()) {
              if (this.isUserHoldingChat || this.isUserScrolledUp) {
                this.showNewMessagesPill.set(true);
                this.accumulatedNewMessagesCount.update(c => c + 1);
              } else {
                this.scrollChatToLatest('smooth');
                this.showNewMessagesPill.set(false);
                this.accumulatedNewMessagesCount.set(0);
              }
            }
          }, 260);
        }

        scheduleNext();
      }, delay);
    };

    scheduleNext();
  }

  private startOnlineCounter() {
    if (this.chatOnlineIntervalId) clearInterval(this.chatOnlineIntervalId);
    this.chatOnlineIntervalId = setInterval(() => {
      const delta = Math.floor(Math.random() * 31) - 15;
      this.chatOnlineCount.update(c => Math.max(7800, Math.min(9200, c + delta)));
    }, 3000);
  }

  public onChatScroll() {
    const el = this.chatScrollRef?.nativeElement;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    this.isUserScrolledUp = distanceFromBottom > 50;
    if (!this.isUserScrolledUp && !this.isUserHoldingChat) {
      this.showNewMessagesPill.set(false);
      this.accumulatedNewMessagesCount.set(0);
    }
  }

  public onChatPointerDown() {
    this.isUserHoldingChat = true;
  }

  public onChatPointerUp() {
    this.isUserHoldingChat = false;
    this.onChatScroll();
  }

  public onChatTouchStart() {
    this.isUserHoldingChat = true;
  }

  public onChatTouchEnd() {
    this.isUserHoldingChat = false;
    this.onChatScroll();
  }

  public onNewMessagesPillClick() {
    this.isUserHoldingChat = false;
    this.isUserScrolledUp = false;
    this.showNewMessagesPill.set(false);
    this.scrollChatToLatest('smooth');
  }

  public toggleLikeMessage(message: ChatMessage) {
    this.chatMessages.update(list =>
      list.map(m => {
        if (m.id === message.id) {
          return { ...m, likes: (m.likes || 0) + 1 };
        }
        return m;
      })
    );
  }

  public scrollChatToLatest(behavior: ScrollBehavior = 'smooth') {
    requestAnimationFrame(() => {
      const element = this.chatScrollRef?.nativeElement;
      if (element) {
        try {
          element.scrollTo({
            top: element.scrollHeight + 2000,
            behavior
          });
        } catch {
          element.scrollTop = element.scrollHeight;
        }
      }
    });
  }

  public toggleChat() {
    this.chatOpen.update(open => !open);
    if (this.chatOpen()) {
      this.isUserHoldingChat = false;
      this.isUserScrolledUp = false;
      this.showNewMessagesPill.set(false);
      this.gameSocket.openChat();
      this.scrollChatToLatest('auto');
    }
  }

  public closeChat() {
    this.chatOpen.set(false);
  }

  public sendChatMessage() {
    const text = this.chatDraft().trim();
    if (!text) return;

    if (!this.chatEligible()) {
      const noticeMessage: ChatMessage = {
        id: `restrict-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        username: 'System',
        text: 'Chat access is restricted for players with balance below 1,000 KES',
        timestamp: new Date().toISOString(),
        isRestrictionNotice: true,
        isBot: false,
      };
      this.chatMessages.update(list => [...list, noticeMessage].slice(-150));
      this.scrollChatToLatest();
      this.chatDraft.set('');
      return;
    }

    if (!this.isConnected()) {
      this.showToast('Chat is connecting. Please try again in a moment.', true);
      return;
    }

    const user = this.currentUser();
    const ownMessage: ChatMessage = {
      id: `own-${Date.now()}`,
      username: user?.username || 'You',
      text,
      timestamp: new Date().toISOString(),
      userId: user?.id || 'current-user',
      avatar: this.gameAvatar(),
      isBot: false,
      likes: 0
    };
    this.chatMessages.update(list => [...list, ownMessage].slice(-200));
    this.isUserScrolledUp = false;
    this.isUserHoldingChat = false;
    this.showNewMessagesPill.set(false);
    this.accumulatedNewMessagesCount.set(0);
    this.scrollChatToLatest('smooth');

    this.gameSocket.sendChatMessage(text, this.gameAvatar());
    this.chatDraft.set('');
  }

  public formatChatTime(timestamp: string): string {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '--:--:--';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  }

  public trackChatMessage(_index: number, message: ChatMessage): string {
    return message.id;
  }

  public chatAvatar(message: ChatMessage): string {
    if (this.isOwnChatMessage(message)) return this.gameAvatar();
    if (message.avatar && !/^(?:\/)?assets\/avatars\/avatar-[\w-]+\.(?:svg|png)$/.test(message.avatar)) {
      return message.avatar;
    }
    // Older server snapshots still contain the previous SVG filenames.
    // Give each participant a consistent new photo while those snapshots expire.
    const identity = String(message.userId || message.username || message.id);
    let hash = 0;
    for (let i = 0; i < identity.length; i++) hash = (Math.imul(hash, 31) + identity.charCodeAt(i)) >>> 0;
    return REFERENCE_AVATARS[hash % REFERENCE_AVATARS.length].path;
  }

  public isOwnChatMessage(message: ChatMessage): boolean {
    const user = this.currentUser();
    const currentUserId = user?.id;
    const currentUsername = user?.username;
    if (message.userId && currentUserId && String(message.userId) === String(currentUserId)) {
      return true;
    }
    if (message.username && currentUsername && message.username.toLowerCase() === currentUsername.toLowerCase()) {
      return true;
    }
    if (message.username === 'You' || message.userId === 'current-user') {
      return true;
    }
    return false;
  }

  public getChatUsernameColor(username: string): string {
    if (!username) return '#60a5fa';
    const colors = [
      '#facc15', // yellow
      '#4ade80', // light green
      '#f87171', // red
      '#38bdf8', // light blue
      '#c084fc', // purple
      '#fb923c', // orange
      '#34d399', // emerald
      '#818cf8', // indigo
      '#f472b6'  // pink
    ];
    let hash = 0;
    for (let i = 0; i < username.length; i++) {
      hash = (hash * 31 + username.charCodeAt(i)) >>> 0;
    }
    return colors[hash % colors.length];
  }

  public openChangeRoomModal(targetRoom?: number) {
    this.closeProfileDropdown();
    this.gameMenuPage.set(null);
    this.showExpandedHistory.set(false);
    const r = targetRoom || this.selectedRoom();
    this.pendingRoomSelection.set(r);
    this.showChangeRoomModal.set(true);
    setTimeout(() => document.querySelector<HTMLInputElement>('.change-room-card input:checked')?.focus(), 0);
  }

  public closeChangeRoomModal() {
    this.showChangeRoomModal.set(false);
  }

  public confirmRoomChange() {
    const targetRoom = this.pendingRoomSelection();
    if (![1, 2, 3].includes(targetRoom) || targetRoom === this.selectedRoom()) return;
    const room = this.getRoom(targetRoom);
    this.selectedRoom.set(targetRoom);
    // Reset renderer-only state to the selected room's live snapshot. The
    // server engines keep running; this only prevents the canvas from carrying
    // the previous room's interpolation or crash animation across the switch.
    this.renderedMultiplierValue = room.animatedMultiplier();
    this.flightProgress = room.flightProgress;
    this.crashFlightProgress = room.crashFlightProgress;
    this.flyingPhaseStartedAt = room.flyingStartedAt;
    this.canvasRoomId = -1;
    this.pausedAnimationPose = null;
    this.flightRenderer?.resume();
    this.showChangeRoomModal.set(false);
    this.connectionLoading.set(true);
    this.startupTimers.push(setTimeout(() => this.connectionLoading.set(false), 600));
    this.syncAudioWithActiveRoom();
  }

  private initUserBetHistory() {
    try {
      const stored = localStorage.getItem('winbet_my_bet_history');
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) {
          this.userBetHistoryList.set(parsed);
          return;
        }
      }
    } catch {
      // fallback
    }

    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    const formattedDate = `${now.getFullYear().toString().slice(-2)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

    const seedItems: UserBetHistoryItem[] = [
      { id: 'h-1', time: '06:55', date: formattedDate, bet: 10.00, multiplier: 1.00, win: 0, cashedOut: false, rawTimestamp: Date.now() - 60000 },
      { id: 'h-2', time: '06:55', date: formattedDate, bet: 10.00, multiplier: 1.01, win: 10.10, cashedOut: true, rawTimestamp: Date.now() - 120000 },
      { id: 'h-3', time: '06:55', date: formattedDate, bet: 10.00, multiplier: 1.01, win: 10.10, cashedOut: true, rawTimestamp: Date.now() - 180000 },
      { id: 'h-4', time: '06:55', date: formattedDate, bet: 10.00, multiplier: 1.01, win: 10.10, cashedOut: true, rawTimestamp: Date.now() - 240000 },
      { id: 'h-5', time: '06:54', date: formattedDate, bet: 10.00, multiplier: 1.01, win: 10.10, cashedOut: true, rawTimestamp: Date.now() - 300000 },
      { id: 'h-6', time: '06:54', date: formattedDate, bet: 10.00, multiplier: 1.01, win: 10.10, cashedOut: true, rawTimestamp: Date.now() - 360000 },
      { id: 'h-7', time: '06:54', date: formattedDate, bet: 10.00, multiplier: 1.03, win: 10.30, cashedOut: true, rawTimestamp: Date.now() - 420000 },
      { id: 'h-8', time: '06:53', date: formattedDate, bet: 10.00, multiplier: 1.04, win: 10.40, cashedOut: true, rawTimestamp: Date.now() - 480000 },
      { id: 'h-9', time: '06:53', date: formattedDate, bet: 10.00, multiplier: 1.31, win: 0, cashedOut: false, rawTimestamp: Date.now() - 540000 },
      { id: 'h-10', time: '06:53', date: formattedDate, bet: 10.00, multiplier: 1.44, win: 0, cashedOut: false, rawTimestamp: Date.now() - 600000 },
      { id: 'h-11', time: '06:52', date: formattedDate, bet: 10.00, multiplier: 2.15, win: 21.50, cashedOut: true, rawTimestamp: Date.now() - 660000 },
      { id: 'h-12', time: '06:50', date: formattedDate, bet: 20.00, multiplier: 3.40, win: 68.00, cashedOut: true, rawTimestamp: Date.now() - 720000 },
    ];
    this.userBetHistoryList.set(seedItems);
    this.saveUserBetHistory();
  }

  private saveUserBetHistory() {
    try {
      localStorage.setItem('winbet_my_bet_history', JSON.stringify(this.userBetHistoryList().slice(0, 50)));
    } catch {}
  }

  public recordUserBetHistory(betAmount: number, multiplier: number, win: number, cashedOut: boolean) {
    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const dateStr = `${now.getFullYear().toString().slice(-2)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

    const newRecord: UserBetHistoryItem = {
      id: `mybet-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      time: timeStr,
      date: dateStr,
      bet: betAmount,
      multiplier: Math.max(1.00, multiplier),
      win: cashedOut ? win : 0,
      cashedOut,
      rawTimestamp: Date.now(),
    };

    this.userBetHistoryList.update(list => [newRecord, ...list].slice(0, 60));
    this.saveUserBetHistory();
  }

  public loadMoreHistory() {
    this.betHistoryLimit.update(lim => lim + 10);
    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    const dateStr = `${now.getFullYear().toString().slice(-2)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const extra: UserBetHistoryItem[] = [
      { id: `gen-${Date.now()}-1`, time: '06:48', date: dateStr, bet: 10.00, multiplier: 1.02, win: 10.20, cashedOut: true, rawTimestamp: Date.now() - 900000 },
      { id: `gen-${Date.now()}-2`, time: '06:46', date: dateStr, bet: 10.00, multiplier: 1.15, win: 11.50, cashedOut: true, rawTimestamp: Date.now() - 1000000 },
      { id: `gen-${Date.now()}-3`, time: '06:44', date: dateStr, bet: 10.00, multiplier: 1.00, win: 0, cashedOut: false, rawTimestamp: Date.now() - 1100000 },
      { id: `gen-${Date.now()}-4`, time: '06:42', date: dateStr, bet: 10.00, multiplier: 1.05, win: 10.50, cashedOut: true, rawTimestamp: Date.now() - 1200000 },
    ];
    this.userBetHistoryList.update(list => [...list, ...extra]);
    this.saveUserBetHistory();
  }

  public shareBetToChat(item: UserBetHistoryItem) {
    this.showHistoryModal.set(false);
    if (item.cashedOut && item.win > 0) {
      this.chatDraft.set(`I just won ${item.win.toFixed(2)} KES at ${item.multiplier.toFixed(2)}x! 🚀`);
    } else {
      this.chatDraft.set(`Just played a round at ${item.multiplier.toFixed(2)}x! 🔥`);
    }
    if (!this.chatOpen()) {
      this.chatOpen.set(true);
      this.gameSocket.openChat();
    }
    this.showToast('Bet copied to chat draft!');
  }

  public openHistoryModal() {
    this.closeProfileDropdown();
    this.showHistoryModal.set(true);
    setTimeout(() => document.querySelector<HTMLButtonElement>('.bet-history-close-btn')?.focus({ preventScroll: true }), 0);
  }

  public formatBetHistoryDate(item: UserBetHistoryItem): string {
    if (!item.rawTimestamp) return item.date;
    const date = new Date(item.rawTimestamp);
    if (!Number.isFinite(date.getTime())) return item.date;
    const pad = (value: number) => value.toString().padStart(2, '0');
    return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear().toString().slice(-2)}`;
  }

  public toggleExpandedHistory(event?: MouseEvent) {
    if (event) {
      event.stopPropagation();
    }
    this.showExpandedHistory.update(v => !v);
  }

  public closeExpandedHistory() {
    this.showExpandedHistory.set(false);
    setTimeout(() => this.roundHistoryToggleRef?.nativeElement.focus({ preventScroll: true }), 0);
  }

  @HostListener('window:keydown.escape')
  onHistoryEscape() {
    this.showHistoryModal.set(false);
    if (this.showExpandedHistory()) this.closeExpandedHistory();
    if (this.showChangeRoomModal()) this.closeChangeRoomModal();
    this.gameMenuPage.set(null);
    this.closeProfileDropdown();
  }

  @HostListener('window:keydown', ['$event'])
  onGameMenuDialogTab(event: KeyboardEvent) {
    if (event.key !== 'Tab' || (!this.showChangeRoomModal() && !this.gameMenuPage() && !this.showHistoryModal())) return;
    const card = document.querySelector(this.showHistoryModal() ? '.bet-history-card' : this.showChangeRoomModal() ? '.change-room-card' : '.game-menu-page-card');
    const controls = card?.querySelectorAll<HTMLElement>('button:not(:disabled), input:checked');
    if (!controls?.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  public navigateToAdmin() {
    this.showProfileDropdown.set(false);
    this.router.navigate(['/admin']);
  }

  public setWalletTab(tab: 'deposit' | 'withdraw' | 'transactions') {
    this.walletTab.set(tab);
    if (tab === 'transactions') {
      this.loadTransactionsHistory();
    }
  }

  public loadTransactionsHistory() {
    this.isLoadingTransactions = true;
    this.authService.getTransactionHistory().subscribe({
      next: (res) => {
        this.transactionHistory = res.transactions || [];
        this.isLoadingTransactions = false;
      },
      error: () => {
        this.isLoadingTransactions = false;
      }
    });
  }

  /** Open the standalone, scrollable deposit page instead of a game overlay. */
  public openWalletModal() {
    localStorage.setItem('walletReturnUrl', '/play');
    this.router.navigate(['/deposit'], { state: { returnUrl: '/play' } });
  }

  /** Reset M-Pesa state when switching to deposit tab */
  public resetMpesaState() {
    this.mpesaStatus.set('idle');
    this.mpesaStatusMsg.set('');
    this.mpesaReceipt.set('');
    this.mpesaCheckoutRequestId = '';
  }

  public formatCooldown(totalSeconds: number): string {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  }

  public startDepositCooldown(seconds: number): void {
    this.clearDepositCooldownTimer();
    this.depositCooldownSeconds.set(Math.max(1, Math.ceil(seconds)));
    this.depositCooldownTimer = setInterval(() => {
      if (this.depositCooldownSeconds() > 1) {
        this.depositCooldownSeconds.update(s => s - 1);
      } else {
        this.depositCooldownSeconds.set(0);
        this.clearDepositCooldownTimer();
        if (this.mpesaStatus() === 'failed' && this.mpesaStatusMsg().includes('rapid')) {
          this.mpesaStatus.set('idle');
          this.mpesaStatusMsg.set('');
        }
      }
    }, 1000);
  }

  public clearDepositCooldownTimer(): void {
    if (this.depositCooldownTimer) {
      clearInterval(this.depositCooldownTimer);
      this.depositCooldownTimer = null;
    }
  }

  public adjustDepositAmount(delta: number) {
    const current = this.depositVal() || 0;
    this.depositVal.set(Math.max(this.minDepositAmount(), current + delta));
    // Deselect any preset when manually adjusting
    this.depositSelectedPreset.set(null);
    this.depositPresetTapCount.set(0);
  }

  public setDepositAmount(amount: number) {
    this.depositVal.set(amount);
  }

  /** Tap once: set amount to preset. Tap again: multiply by tap count. */
  public selectDepositPreset(preset: number) {
    if (this.depositSelectedPreset() === preset) {
      const newTapCount = this.depositPresetTapCount() + 1;
      this.depositPresetTapCount.set(newTapCount);
      this.depositVal.set(preset * newTapCount);
    } else {
      this.depositSelectedPreset.set(preset);
      this.depositPresetTapCount.set(1);
      this.depositVal.set(preset);
    }
  }

  public addDepositAmount(val: number) {
    const current = this.depositVal() || 0;
    this.depositVal.set(current + val);
  }

  public adjustWithdrawAmount(delta: number) {
    const current = this.withdrawVal() || 0;
    this.withdrawVal.set(Math.max(10, current + delta));
    this.withdrawSelectedPreset.set(null);
    this.withdrawPresetTapCount.set(0);
  }

  public selectWithdrawPreset(preset: number) {
    if (this.withdrawSelectedPreset() === preset) {
      const newTapCount = this.withdrawPresetTapCount() + 1;
      this.withdrawPresetTapCount.set(newTapCount);
      this.withdrawVal.set(preset * newTapCount);
    } else {
      this.withdrawSelectedPreset.set(preset);
      this.withdrawPresetTapCount.set(1);
      this.withdrawVal.set(preset);
    }
  }

  public addWithdrawAmount(val: number) {
    const current = this.withdrawVal() || 0;
    this.withdrawVal.set(current + val);
  }

  private mpesaPollingInterval: any = null;

  public submitDeposit() {
    if (this.depositCooldownSeconds() > 0) {
      const waitMsg = `Too many rapid deposit prompts. Please wait ${this.formatCooldown(this.depositCooldownSeconds())} before trying again.`;
      this.showToast(waitMsg, true);
      this.mpesaStatus.set('failed');
      this.mpesaStatusMsg.set(waitMsg);
      return;
    }
    const amount = this.depositVal();
    const minDeposit = this.minDepositAmount();
    if (isNaN(amount) || amount < minDeposit) {
      this.showToast(`Minimum deposit is KES ${minDeposit.toLocaleString()}`, true);
      return;
    }
    const maxDeposit = this.maxDepositAmount();
    if (amount > maxDeposit) {
      const maxMsg = `Maximum deposit amount is KES ${maxDeposit.toLocaleString()} per transaction.`;
      this.showToast(maxMsg, true);
      this.mpesaStatus.set('failed');
      this.mpesaStatusMsg.set(maxMsg);
      return;
    }

    const rawPhone = this.mpesaPhone() || this.currentUser()?.phone_number || '';
    const cleanDigits = rawPhone.replace(/\D/g, '').replace(/^(254|0)+/, '');
    if (!cleanDigits || cleanDigits.length < 9) {
      this.showToast('Please enter a valid phone number for the M-Pesa prompt.', true);
      return;
    }
    const phone = `254${cleanDigits}`;

    this.mpesaStatus.set('sending');
    this.mpesaStatusMsg.set('Initiating M-Pesa STK Push...');

    this.authService.initiateMpesaSTKPush(amount, phone).pipe(
      finalize(() => {
        if (this.mpesaStatus() === 'sending') {
          this.mpesaStatus.set('idle');
        }
      })
    ).subscribe({
      next: (res) => {
        this.mpesaCheckoutRequestId = res.checkoutRequestId;
        this.mpesaStatus.set('idle');
        this.mpesaStatusMsg.set(`📱 Check phone (${phone})! Enter your M-Pesa PIN to confirm KES ${amount}.`);
        this.loadTransactionsHistory();
        this.startMpesaStatusPolling();
      },
      error: (err: any) => {
        this.mpesaStatus.set('failed');
        const msg = typeof err === 'string' ? err : (err?.message || 'STK Push failed.');
        this.mpesaStatusMsg.set(this.friendlyPaymentError(msg));
        if (err?.code === 'RATE_LIMIT_COOLDOWN' || err?.retryAfterSeconds || err?.status === 429) {
          const cooldownSec = Number(err?.retryAfterSeconds) || 600;
          this.startDepositCooldown(cooldownSec);
        }
      }
    });
  }

  private startMpesaStatusPolling() {
    if (this.mpesaPollingInterval) {
      clearInterval(this.mpesaPollingInterval);
    }

    const reqId = this.mpesaCheckoutRequestId;
    let pollCount = 0;
    this.mpesaPollingInterval = setInterval(() => {
      pollCount++;
      if (this.mpesaStatus() !== 'waiting' || pollCount > 30) {
        clearInterval(this.mpesaPollingInterval);
        this.mpesaPollingInterval = null;
        if (pollCount > 30 && this.mpesaStatus() === 'waiting') {
          this.mpesaStatus.set('failed');
          this.mpesaStatusMsg.set('❌ M-Pesa payment prompt timed out.');
          this.showToast('M-Pesa payment prompt timed out.', true);
        }
        return;
      }

      if (reqId) {
        this.authService.checkMpesaStatus(reqId).subscribe({
          next: (res) => {
            if (res.status === 'completed') {
              this.mpesaStatus.set('success');
              if (res.balance !== undefined) this.authService.updateBalance(Number(res.balance));
              this.showToast('💰 M-Pesa deposit confirmed!');
              clearInterval(this.mpesaPollingInterval);
              this.mpesaPollingInterval = null;
            } else if (res.status === 'failed') {
              this.mpesaStatus.set('failed');
              this.mpesaStatusMsg.set(`❌ ${res.reason || 'Payment failed or was cancelled.'}`);
              clearInterval(this.mpesaPollingInterval);
              this.mpesaPollingInterval = null;
            }
          },
          error: () => undefined
        });
      }
    }, 1500);
  }

  public cancelPendingStk() {
    const reqId = this.mpesaCheckoutRequestId;
    if (reqId) {
      this.authService.cancelPendingMpesa(reqId).subscribe({
        next: () => {
          this.resetMpesaState();
          this.showToast('M-Pesa STK request cancelled.');
          this.loadTransactionsHistory();
        },
        error: () => {
          this.resetMpesaState();
          this.loadTransactionsHistory();
        }
      });
    } else {
      this.resetMpesaState();
    }
  }

  public submitWithdraw() {
    const val = this.withdrawVal();
    if (this.isSubmittingWithdrawal()) return;
    if (val < 200) {
      this.showToast('Minimum withdrawal is 200 KES', true);
      return;
    }
    const phone = this.mpesaPhone() || this.currentUser()?.phone_number || '';
    this.isSubmittingWithdrawal.set(true);
    this.authService.withdraw(val, phone).subscribe({
      next: (res) => {
        const notification = typeof res.notification === 'string'
          ? {
              id: Date.now(),
              title: 'Withdrawal Notice',
              message: res.notification,
              type: res.status === 'completed' ? 'completed' : 'pending',
              createdAt: new Date().toISOString()
            }
          : res.notification;
        // Keep the modal open and on the withdraw tab so player sees admin-edited notification
        this.walletTab.set('withdraw');
        this.showWithdrawalNotification(notification);
        this.loadTransactionsHistory();
        // Close the modal after the notification auto-dismisses (6s)
        setTimeout(() => this.showWalletModal.set(false), 6000);
        this.isSubmittingWithdrawal.set(false);
      },
      error: (message: string) => {
        this.showToast(message || 'Withdrawal could not be completed.', true);
        // An insufficient-balance request is recorded server-side as failed.
        this.transactionHistoryTab.set('withdrawal');
        this.loadTransactionsHistory();
        this.isSubmittingWithdrawal.set(false);
      }
    });
  }

  public goBack() {
    this.router.navigate(['/bets']);
  }


  public toggleProfileDropdown() {
    this.showExpandedHistory.set(false);
    const storedAvatar = localStorage.getItem(`aviator_avatar_${this.currentUser()?.id || 'guest'}`);
    if (storedAvatar && this.avatarChoices.some(avatar => avatar.path === storedAvatar)) this.gameAvatar.set(storedAvatar);
    this.showProfileDropdown.update(v => !v);
  }

  public closeProfileDropdown() {
    this.showProfileDropdown.set(false);
  }

  public openDepositFromProfile() {
    this.showProfileDropdown.set(false);
    localStorage.setItem('walletReturnUrl', '/play');
    this.router.navigate(['/deposit'], { state: { returnUrl: '/play' } });
  }

  public openWalletPage() {
    localStorage.setItem('walletReturnUrl', '/play');
    this.router.navigate(['/wallet'], { state: { returnUrl: '/play' } });
  }

  public openWithdrawFromProfile() {
    this.showProfileDropdown.set(false);
    localStorage.setItem('walletReturnUrl', '/play');
    this.router.navigate(['/withdraw'], { state: { returnUrl: '/play' } });
  }

  public claimBonus() {
    this.claimWelcomeBonus();
  }

  private friendlyPaymentError(message: string): string {
    const detail = String(message || '').trim();
    if (/endpoint not found|stk push failed|payhero/i.test(detail)) {
      return 'M-Pesa is temporarily unavailable. No payment request was sent. Please try again shortly.';
    }
    if (/unauthorized|log in/i.test(detail)) {
      return 'Your session has expired. Log in again, then retry the deposit.';
    }
    return detail || 'We could not start the M-Pesa request. Please try again.';
  }

  public logout() {
    this.showProfileDropdown.set(false);
    this.authService.logout();
    this.router.navigate(['/login']);
  }

  public toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }

  public showToast(msg: string, isError = false) {
    this.toastMessage.set(msg);
    this.isToastError.set(isError);
    setTimeout(() => {
      if (this.toastMessage() === msg) {
        this.toastMessage.set(null);
      }
    }, 4000);
  }
}
