import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { BotsRegistry } from './bots.registry';
import { Alert, SmartVolType } from './interfaces';
import { DominationStrategy } from './strategies/domination.strategy';

// Добавляем типы для Domination сигналов
export type DominationAlertType =
  | 'Buyer domination'
  | 'Seller domination'
  | 'Continuation of buyer dominance'
  | 'Continuation of seller dominance';

export type AllAlertType = SmartVolType | DominationAlertType;

function toAlert(p: any): any {
  if (!p || typeof p !== 'object')
    throw new BadRequestException('Invalid payload');
  if (!('alertName' in p))
    throw new BadRequestException(
      'Only SmartVol and Domination alerts are supported',
    );

  const type = String(p.alertName);

  // Проверяем SmartVol сигналы
  if (
    [
      'SmartOpen',
      'SmartVolAdd',
      'SmartClose',
      'SmartBigClose',
      'SmartBigAdd',
      'SmartVolumeOpen',
      'BullishVolume',
      'VolumeUp',
    ].includes(type)
  ) {
    if (!p.symbol || p.price == null)
      throw new BadRequestException('symbol and price are required');

    if (type === 'VolumeUp') {
      if (p.volume == null)
        throw new BadRequestException('volume is required for VolumeUp alerts');
      if (!p.timeframe)
        throw new BadRequestException(
          'timeframe is required for VolumeUp alerts',
        );
      return {
        kind: 'smartvol',
        type: type as SmartVolType,
        symbol: String(p.symbol),
        price: String(p.price),
        timeframe: String(p.timeframe),
        volume: Number(p.volume),
      };
    }

    return {
      kind: 'smartvol',
      type: type as SmartVolType,
      symbol: String(p.symbol),
      price: String(p.price),
      timeframe: p.timeframe,
    };
  }

  // Проверяем Domination сигналы
  if (
    [
      'Buyer domination',
      'Seller domination',
      'Continuation of buyer dominance',
      'Continuation of seller dominance',
    ].includes(type)
  ) {
    if (!p.symbol || p.price == null)
      throw new BadRequestException('symbol and price are required');

    return {
      kind: 'domination',
      type: type as DominationAlertType,
      symbol: String(p.symbol),
      price: String(p.price),
      timeframe: p.timeframe,
    };
  }

  throw new BadRequestException(`Unknown alert type: ${type}`);
}

@Injectable()
export class AlertsRouter {
  private readonly log = new Logger(AlertsRouter.name);

  constructor(
    private readonly registry: BotsRegistry,
    private readonly dominationStrategy: DominationStrategy,
  ) {}

  async handle(payload: any) {
    const alert = toAlert(payload);

    // Обрабатываем Domination сигналы отдельно
    if (alert.kind === 'domination') {
      await this.handleDominationAlert(alert);
      return;
    }

    // Обрабатываем SmartVol сигналы как обычно
    for (const bot of this.registry.all()) {
      const filter = bot.cfg.symbol_filter || [];
      if (filter.length && !filter.includes(alert.symbol)) continue;
      try {
        await bot.process(alert);
      } catch (e: any) {
        this.log.warn(`${bot.name} failed: ${e.message}`);
      }
    }
  }

  /**
   * Обрабатывает Domination сигналы
   */
  private async handleDominationAlert(alert: {
    kind: 'domination';
    type: DominationAlertType;
    symbol: string;
    price: string;
    timeframe?: string;
  }) {
    this.log.log(
      `🎯 Обрабатываю Domination сигнал: ${alert.type} для ${alert.symbol}`,
    );

    // Получаем только ботов с strategy: 'domination'
    const bots = this.registry
      .all()
      .filter((bot) => bot.cfg.strategy === 'domination');

    if (bots.length === 0) {
      this.log.warn(
        `⚠️ Не найдено ботов с strategy: 'domination' для обработки Domination алерта`,
      );
      return;
    }

    this.log.log(
      `🎯 Найдено ${bots.length} ботов для Domination стратегии: ${bots.map((b) => b.name).join(', ')}`,
    );

    for (const bot of bots) {
      try {
        await this.processDominationAlert(bot, alert);
      } catch (error) {
        this.log.error(
          `❌ Ошибка обработки Domination алерта для бота ${bot.name}: ${error.message}`,
        );
      }
    }
  }

  /**
   * Обрабатывает Domination алерт для конкретного бота
   */
  private async processDominationAlert(
    bot: any,
    alert: {
      kind: 'domination';
      type: DominationAlertType;
      symbol: string;
      price: string;
      timeframe?: string;
    },
  ): Promise<void> {
    // Дополнительная проверка - убеждаемся что бот использует Domination стратегию
    if (bot.cfg.strategy !== 'domination') {
      this.log.warn(
        `⚠️ Бот ${bot.name} не использует Domination стратегию (strategy: ${bot.cfg.strategy})`,
      );
      return;
    }

    // Проверяем фильтр символов
    const filter = bot.cfg.symbol_filter || [];
    if (filter.length && !filter.includes(alert.symbol)) {
      this.log.log(
        `⏭️ Бот ${bot.name} пропускает ${alert.symbol} (фильтр: ${filter.join(',')})`,
      );
      return;
    }

    this.log.log(
      `✅ Бот ${bot.name} обрабатывает Domination алерт: ${alert.type} для ${alert.symbol}`,
    );

    switch (alert.type) {
      case 'Buyer domination':
        await this.dominationStrategy.onBuyerDomination(bot, alert);
        break;

      case 'Seller domination':
        await this.dominationStrategy.onSellerDomination(bot, alert);
        break;

      case 'Continuation of buyer dominance':
        await this.dominationStrategy.onBuyerContinuation(bot, alert);
        break;

      case 'Continuation of seller dominance':
        await this.dominationStrategy.onSellerContinuation(bot, alert);
        break;

      default:
        this.log.warn(`⚠️ Неизвестный тип Domination алерта: ${alert.type}`);
    }
  }
}
