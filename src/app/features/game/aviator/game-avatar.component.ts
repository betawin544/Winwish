import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

export const REFERENCE_AVATARS = [
  'Golden dog', 'Blue jet', 'Red helmet', 'Pug',
  'Red sports car', 'Silver sedan', 'Chrome helmet', 'Moon',
  'Red watch', 'Teal sneaker', 'Propeller', 'Colorful sneakers',
  'Hoodie', 'Gorilla', 'Tiger', 'Playing cards'
].map((name, index) => ({ name, path: `assets/avatars/reference-avatars-v1.png#${index}` }));

/** Reuses one generated photographic sheet across all avatar sizes. */
@Component({
  selector: 'app-game-avatar',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span *ngIf="spriteStyle; else normalImage" role="img" [attr.aria-label]="alt" [ngStyle]="spriteStyle"></span>
    <ng-template #normalImage><img [src]="src" [alt]="alt" loading="lazy" /></ng-template>
  `,
  styles: [`
    :host { display: block; overflow: hidden; border-radius: 50%; }
    span, img { display: block; width: 100%; height: 100%; border-radius: inherit; }
    img { object-fit: cover; }
    span { background-repeat: no-repeat; }
  `]
})
export class GameAvatarComponent {
  @Input() alt = '';
  private source = '';
  spriteStyle: Record<string, string> | null = null;

  @Input() set src(value: string) {
    this.source = value;
    const match = value.match(/^assets\/avatars\/reference-avatars-v1\.png#(\d+)$/);
    const index = match ? Number(match[1]) : -1;
    this.spriteStyle = null;
    if (index < 0 || index > 15) return;
    // The generated sheet has slightly different row heights; crop each cell precisely.
    const columns = [0, 314, 627, 940, 1254];
    const rows = [0, 314, 618, 920, 1254];
    const column = index % 4;
    const row = Math.floor(index / 4);
    const width = columns[column + 1] - columns[column];
    const height = rows[row + 1] - rows[row];
    this.spriteStyle = {
      backgroundImage: 'url("assets/avatars/reference-avatars-v1.png")',
      backgroundSize: `${1254 / width * 100}% ${1254 / height * 100}%`,
      backgroundPosition: `${columns[column] / (1254 - width) * 100}% ${rows[row] / (1254 - height) * 100}%`
    };
  }

  get src(): string { return this.source; }
}
