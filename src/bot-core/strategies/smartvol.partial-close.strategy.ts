import { Strategy } from '../interfaces';
import { toBitgetSymbolId } from '../utils';
import { PositionsStore } from '../positions.store';
import { VolumeUpService } from '../../services/volume-up.service';
import { Logger } from '@nestjs/common';

// In-memory состояние для отслеживания SmartVolClose сигналов
interface PartialCloseState {
  symbol: string;
  botName: string;
  smartVolCloseCount: number;
  lastUpdate: number;
}

// Состояние блокировки входа
interface EntryBlockState {
  symbol: string;
  botName: string;
  blockedUntil: number; // timestamp когда блокировка снимается
}

export class SmartVolPartialCloseStrategy implements Strategy {
  private readonly logger = new Logger(SmartVolPartialCloseStrategy.name);

  // In-memory хранилище состояния частичного закрытия
  private partialCloseStates = new Map<string, PartialCloseState>();

  // In-memory хранилище состояния блокировки входа
  private entryBlockStates = new Map<string, EntryBlockState>();

  constructor(
    private readonly store: PositionsStore,
    private readonly volumeUpService: VolumeUpService,
  ) {}

  // Генерируем ключ для состояния
  private getStateKey(botName: string, symbol: string): string {
    return `${botName}:${symbol}`;
  }

  // Получаем или создаем состояние
  private getOrCreateState(botName: string, symbol: string): PartialCloseState {
    const key = this.getStateKey(botName, symbol);
    let state = this.partialCloseStates.get(key);

    if (!state) {
      state = {
        symbol,
        botName,
        smartVolCloseCount: 0,
        lastUpdate: Date.now(),
      };
      this.partialCloseStates.set(key, state);
    }

    return state;
  }

  // Очищаем состояние при закрытии позиции
  private clearState(botName: string, symbol: string): void {
    const key = this.getStateKey(botName, symbol);
    this.partialCloseStates.delete(key);
  }

  // Проверяем, заблокирован ли вход для символа
  private isEntryBlocked(botName: string, symbol: string): boolean {
    const key = this.getStateKey(botName, symbol);
    const blockState = this.entryBlockStates.get(key);

    if (!blockState) return false;

    const now = Date.now();
    if (now >= blockState.blockedUntil) {
      // Блокировка истекла, удаляем состояние
      this.entryBlockStates.delete(key);
      return false;
    }

    return true;
  }

  // Блокируем вход на 1 час
  private blockEntry(botName: string, symbol: string, reason: string): void {
    const key = this.getStateKey(botName, symbol);
    const blockedUntil = Date.now() + 60 * 60 * 1000; // 1 час

    this.entryBlockStates.set(key, {
      symbol,
      botName,
      blockedUntil,
    });

    this.logger.log(
      `🔒 Вход заблокирован для ${symbol} (${botName}) на 1 час. Причина: ${reason}. Разблокировка в ${new Date(blockedUntil).toLocaleString()}`,
    );
  }

  // Получаем время до разблокировки
  private getTimeUntilUnblock(botName: string, symbol: string): string {
    const key = this.getStateKey(botName, symbol);
    const blockState = this.entryBlockStates.get(key);

    if (!blockState) return 'не заблокирован';

    const now = Date.now();
    if (now >= blockState.blockedUntil) return 'разблокирован';

    const remainingMs = blockState.blockedUntil - now;
    const hours = Math.floor(remainingMs / (1000 * 60 * 60));
    const minutes = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));

    return `${hours}ч ${minutes}м`;
  }

  async onOpen(bot, alert) {
    this.logger.log(`🚀 Стратегия onOpen для ${alert.symbol} @${alert.price}`);

    // Проверяем блокировку входа
    if (this.isEntryBlocked(bot.name, alert.symbol)) {
      const timeUntilUnblock = this.getTimeUntilUnblock(bot.name, alert.symbol);
      this.logger.log(
        `⏸ Вход заблокирован для ${alert.symbol} (${bot.name}) - ${timeUntilUnblock}`,
      );
      await bot.notify(
        `⏸ ${bot.name}: Вход заблокирован для ${alert.symbol} - ${timeUntilUnblock}`,
      );
      return;
    }

    // Проверяем таймфрейм - открываем ТОЛЬКО при 1h
    const timeframe = alert.timeframe || '1h';
    if (timeframe !== '1h') {
      this.logger.log(
        `⏸ SmartOpen с таймфреймом ${timeframe} - пропускаю (нужен 1h)`,
      );
      await bot.notify(
        `⏸ ${bot.name}: SmartOpen с таймфреймом ${timeframe} пропущен - нужен таймфрейм 1h для открытия позиции`,
      );
      return;
    }

    this.logger.log(`🔍 Проверяю существующую позицию для ${alert.symbol}`);
    const existing = await this.store.findOpen(bot.name, alert.symbol);
    if (existing) {
      this.logger.log(
        `📊 Найдена существующая позиция: ${existing.fillsCount}/${bot.cfg.maxFills ?? 4} заполнений`,
      );
      if (existing.fillsCount >= (bot.cfg.maxFills ?? 4)) {
        this.logger.log(`⚠️ Достигнут максимум заполнений`);
        await bot.notify(
          `⚠️ ${bot.name}: max fills reached for ${alert.symbol}`,
        );
        return;
      }
      this.logger.log(`➕ Переходим к докупке`);
      return this.onAdd(bot, alert);
    }
    this.logger.log(`🆕 Позиция не найдена, открываю новую`);

    const symbolId = toBitgetSymbolId(alert.symbol);
    this.logger.log(`🔧 Символ для биржи: ${symbolId}`);

    if (bot.exchange.isAllowed && !bot.exchange.isAllowed(symbolId)) {
      this.logger.log(`❌ Символ ${symbolId} не разрешен`);
      await bot.notify(`⚠️ ${bot.name}: ${symbolId} not allowed`);
      return;
    }
    this.logger.log(`✅ Символ ${symbolId} разрешен`);
    this.logger.log(`⚙️ Устанавливаю плечо: ${bot.cfg.smartvol.leverage}`);
    await bot.exchange.ensureLeverage?.(
      symbolId,
      String(bot.cfg.smartvol.leverage),
    );

    this.logger.log(`💰 Рассчитываю размер позиции для $${bot.baseUsd()}`);
    const size = await bot.exchange.calcSizeFromUsd?.(
      symbolId,
      Number(alert.price),
      bot.baseUsd(),
    );
    this.logger.log(`📊 Размер позиции: ${size}`);

    this.logger.log(`📈 Размещаю рыночный ордер`);
    await bot.exchange.placeMarket?.(
      symbolId,
      'buy',
      String(size),
      `${bot.name}-open-${Date.now()}`,
    );
    const baseUsd = bot.baseUsd();
    if (!baseUsd || isNaN(baseUsd)) {
      this.logger.error(
        `❌ Ошибка: baseUsd не определен или не является числом: ${baseUsd}`,
      );
      await bot.notify(
        `❌ ${bot.name}: Ошибка конфигурации - baseUsd не определен`,
      );
      return;
    }

    this.logger.log(
      `💾 Создаю позицию в БД: ${bot.name}, ${alert.symbol}, ${alert.price}, $${baseUsd}`,
    );
    const position = await this.store.open(
      bot.name,
      alert.symbol,
      alert.price,
      String(baseUsd),
    );
    this.logger.log(`✅ Позиция создана в БД с ID: ${position.id}`);

    // Инициализируем состояние частичного закрытия
    this.getOrCreateState(bot.name, alert.symbol);

    const positionInfo = this.store.getPositionInfo(
      position,
      Number(alert.price),
    );

    await bot.notify(
      `✅ ${bot.name}: OPEN ${alert.symbol} @${alert.price} $${baseUsd}\n` +
        `📊 Размер: ${positionInfo.pnl?.totalSize || '0'} ${alert.symbol.replace('USDT', '')}\n` +
        `💰 Средняя цена: $${positionInfo.pnl?.avgEntryPrice || alert.price}\n` +
        `📈 Текущая цена: $${positionInfo.pnl?.currentPrice || alert.price}\n` +
        `💵 PnL: $${positionInfo.pnl?.pnl || '0'} (${positionInfo.pnl?.pnlPercent || '0'}%)`,
    );
  }

  async onAdd(bot, alert) {
    this.logger.log(`➕ Стратегия onAdd для ${alert.symbol} @${alert.price}`);

    const existing = await this.store.findOpen(bot.name, alert.symbol);
    if (!existing) {
      this.logger.log(
        `⚠️ Позиция ${alert.symbol} не найдена в БД для бота ${bot.name}, пропускаю докупку`,
      );
      return;
    }

    if (existing.fillsCount >= (bot.cfg.maxFills ?? 4)) {
      await bot.notify(`⚠️ ${bot.name}: max fills reached for ${alert.symbol}`);
      return;
    }

    const addUsd = bot.addUsd();
    if (!addUsd || isNaN(addUsd)) {
      this.logger.error(
        `❌ Ошибка: addUsd не определен или не является числом: ${addUsd}`,
      );
      await bot.notify(
        `❌ ${bot.name}: Ошибка конфигурации - addUsd не определен`,
      );
      return;
    }

    const symbolId = toBitgetSymbolId(alert.symbol);
    const size = await bot.exchange.calcSizeFromUsd?.(
      symbolId,
      Number(alert.price),
      addUsd,
    );
    await bot.exchange.placeMarket?.(
      symbolId,
      'buy',
      String(size),
      `${bot.name}-add-${Date.now()}`,
    );
    await this.store.add(existing, alert.price, String(addUsd));

    const updatedPosition = await this.store.findOpen(bot.name, alert.symbol);
    if (updatedPosition) {
      const positionInfo = this.store.getPositionInfo(
        updatedPosition,
        Number(alert.price),
      );

      await bot.notify(
        `➕ ${bot.name}: ADD ${alert.symbol} @${alert.price} $${addUsd}\n` +
          `📊 Новый размер: ${positionInfo.pnl?.totalSize || '0'} ${alert.symbol.replace('USDT', '')}\n` +
          `💰 Новая средняя цена: $${positionInfo.pnl?.avgEntryPrice || alert.price}\n` +
          `📈 Текущая цена: ${positionInfo.pnl?.currentPrice || alert.price}\n` +
          `💵 PnL: $${positionInfo.pnl?.pnl || '0'} (${positionInfo.pnl?.pnlPercent || '0'}%)`,
      );
    } else {
      await bot.notify(
        `➕ ${bot.name}: ADD ${alert.symbol} @${alert.price} $${addUsd}`,
      );
    }
  }

  async onClose(bot, alert) {
    this.logger.log(
      `🔄 SmartClose (${alert.timeframe || '1h'}) для ${alert.symbol}`,
    );

    const existing = await this.store.findOpen(bot.name, alert.symbol);
    if (!existing) {
      this.logger.log(
        `⚠️ Позиция ${alert.symbol} не найдена в БД для бота ${bot.name}, пропускаю закрытие`,
      );
      return;
    }

    // Проверяем таймфрейм
    const timeframe = alert.timeframe || '1h';

    if (timeframe === '4h') {
      // 4h SmartClose - закрываем всю позицию сразу
      this.logger.log(
        `🛑 4h SmartClose - закрываю всю позицию ${alert.symbol}`,
      );

      try {
        await bot.exchange.flashClose?.(alert.symbol, 'long');
        const finalPnL = this.store.calculatePnL(existing, Number(alert.price));
        await this.store.close(existing, alert.price);

        // Очищаем состояние частичного закрытия
        this.clearState(bot.name, alert.symbol);

        await bot.notify(
          `🛑 ${bot.name}: CLOSE 4h ${alert.symbol} @${alert.price}\n` +
            `📊 Финальный размер: ${finalPnL.totalSize} ${alert.symbol.replace('USDT', '')}\n` +
            `💰 Средняя цена входа: $${finalPnL.avgEntryPrice}\n` +
            `📈 Цена закрытия: $${finalPnL.currentPrice}\n` +
            `💵 Финальный PnL: $${finalPnL.pnl} (${finalPnL.pnlPercent}%)`,
        );
      } catch (error) {
        this.logger.error(
          `❌ Ошибка при закрытии позиции ${alert.symbol}: ${error.message}`,
        );
        throw error;
      }
      return;
    }

    // 1h SmartClose - логика частичного закрытия
    const state = this.getOrCreateState(bot.name, alert.symbol);
    const currentCount = state.smartVolCloseCount;

    if (currentCount === 0) {
      // Первый SmartClose - только увеличиваем счетчик
      this.logger.log(
        `📊 Первый SmartClose для ${alert.symbol} - увеличиваю счетчик`,
      );
      state.smartVolCloseCount = 1;
      state.lastUpdate = Date.now();

      await bot.notify(
        `⏳ ${bot.name}: Первый SmartClose для ${alert.symbol} - ожидаю второй сигнал для частичного закрытия`,
      );
      return;
    } else if (currentCount === 1) {
      // Второй SmartClose - закрываем 50%
      this.logger.log(
        `🔄 Второй SmartClose для ${alert.symbol} - закрываю 50%`,
      );

      try {
        // Закрываем 50% позиции
        const currentSize = parseFloat(existing.amountUsd);
        const closeSize = currentSize * 0.5;

        // Получаем размер в токенах для закрытия
        const avgPrice = parseFloat(existing.avgEntryPrice);
        const closeTokens = closeSize / avgPrice;

        await bot.exchange.placeMarket?.(
          toBitgetSymbolId(alert.symbol),
          'sell',
          closeTokens.toFixed(8),
          `${bot.name}-partial-close-${Date.now()}`,
        );

        // Обновляем состояние
        state.smartVolCloseCount = 2;
        state.lastUpdate = Date.now();

        await bot.notify(
          `🔄 ${bot.name}: Частичное закрытие 50% ${alert.symbol} @${alert.price}\n` +
            `📊 Закрыто: $${closeSize.toFixed(2)}\n` +
            `📊 Осталось: $${(currentSize - closeSize).toFixed(2)}`,
        );
      } catch (error) {
        this.logger.error(
          `❌ Ошибка при частичном закрытии позиции ${alert.symbol}: ${error.message}`,
        );
        throw error;
      }
    } else if (currentCount >= 2) {
      // Третий и последующие SmartClose - закрываем оставшуюся часть
      this.logger.log(
        `🛑 ${currentCount + 1}-й SmartClose для ${alert.symbol} - закрываю оставшуюся часть`,
      );

      try {
        await bot.exchange.flashClose?.(alert.symbol, 'long');
        const finalPnL = this.store.calculatePnL(existing, Number(alert.price));
        await this.store.close(existing, alert.price);

        // Очищаем состояние частичного закрытия
        this.clearState(bot.name, alert.symbol);

        await bot.notify(
          `🛑 ${bot.name}: Финальное закрытие ${alert.symbol} @${alert.price}\n` +
            `📊 Финальный размер: ${finalPnL.totalSize} ${alert.symbol.replace('USDT', '')}\n` +
            `💰 Средняя цена входа: $${finalPnL.avgEntryPrice}\n` +
            `📈 Цена закрытия: $${finalPnL.currentPrice}\n` +
            `💵 Финальный PnL: $${finalPnL.pnl} (${finalPnL.pnlPercent}%)`,
        );
      } catch (error) {
        this.logger.error(
          `❌ Ошибка при закрытии позиции ${alert.symbol}: ${error.message}`,
        );
        throw error;
      }
    }
  }

  async onBigClose(bot, alert) {
    this.logger.log(
      `🚨 SmartBigClose для ${alert.symbol} - экстренное закрытие всей позиции`,
    );

    const existing = await this.store.findOpen(bot.name, alert.symbol);
    if (!existing) {
      this.logger.log(
        `⚠️ Позиция ${alert.symbol} не найдена в БД для бота ${bot.name}, пропускаю закрытие`,
      );
      return;
    }

    try {
      await bot.exchange.flashClose?.(alert.symbol, 'long');
      const finalPnL = this.store.calculatePnL(existing, Number(alert.price));
      await this.store.close(existing, alert.price);

      // Очищаем состояние частичного закрытия
      this.clearState(bot.name, alert.symbol);

      await bot.notify(
        `🚨 ${bot.name}: BIG CLOSE ${alert.symbol} @${alert.price}\n` +
          `📊 Финальный размер: ${finalPnL.totalSize} ${alert.symbol.replace('USDT', '')}\n` +
          `💰 Средняя цена входа: $${finalPnL.avgEntryPrice}\n` +
          `📈 Цена закрытия: $${finalPnL.currentPrice}\n` +
          `💵 Финальный PnL: $${finalPnL.pnl} (${finalPnL.pnlPercent}%)`,
      );
    } catch (error) {
      this.logger.error(
        `❌ Ошибка при экстренном закрытии позиции ${alert.symbol}: ${error.message}`,
      );
      throw error;
    }
  }

  async onBigAdd(bot, alert) {
    this.logger.log(`🚀 SmartBigAdd для ${alert.symbol} - большая докупка`);

    // Логика для SmartBigAdd (можно реализовать по необходимости)
    await bot.notify(
      `🚀 ${bot.name}: BIG ADD сигнал для ${alert.symbol} @${alert.price}`,
    );
  }

  // Метод для SmartVolumeOpen (не используется в этой стратегии)
  async onSmartVolumeOpen(bot, alert) {
    this.logger.log(
      `📊 SmartVolumeOpen не используется в Partial Close стратегии`,
    );
    // Молча пропускаем - не отправляем уведомления
  }

  // Метод для BullishVolume (не используется в этой стратегии)
  async onBullishVolume(bot, alert) {
    this.logger.log(
      `🐂 BullishVolume не используется в Partial Close стратегии`,
    );
    // Молча пропускаем - не отправляем уведомления
  }

  // Метод для VolumeUp (не используется в этой стратегии)
  async onVolumeUp(bot, alert) {
    this.logger.log(`📊 VolumeUp не используется в Partial Close стратегии`);
    // Молча пропускаем - не отправляем уведомления
  }

  // Новые методы для обработки алертов синхронизации
  async onFixedShortSynchronization(bot, alert) {
    this.logger.log(
      `🔒 Fixed Short Synchronization для ${alert.symbol} (${bot.name})`,
    );

    // Проверяем таймфрейм - обрабатываем ТОЛЬКО при 1h
    const timeframe = alert.timeframe || '1h';
    if (timeframe !== '1h') {
      this.logger.log(
        `⏸ Fixed Short Synchronization с таймфреймом ${timeframe} - пропускаю (нужен 1h)`,
      );
      return;
    }

    // Блокируем вход на 1 час
    this.blockEntry(bot.name, alert.symbol, 'Fixed Short Synchronization');

    await bot.notify(
      `🔒 ${bot.name}: Fixed Short Synchronization для ${alert.symbol} @${alert.price}\n` +
        `⏸ Вход заблокирован на 1 час\n` +
        `📅 Разблокировка: ${new Date(Date.now() + 60 * 60 * 1000).toLocaleString()}`,
    );
  }

  async onLiveShortSynchronization(bot, alert) {
    this.logger.log(
      `🔒 Live Short Synchronization для ${alert.symbol} (${bot.name})`,
    );

    // Проверяем таймфрейм - обрабатываем ТОЛЬКО при 1h
    const timeframe = alert.timeframe || '1h';
    if (timeframe !== '1h') {
      this.logger.log(
        `⏸ Live Short Synchronization с таймфреймом ${timeframe} - пропускаю (нужен 1h)`,
      );
      return;
    }

    // Блокируем вход на 1 час
    this.blockEntry(bot.name, alert.symbol, 'Live Short Synchronization');

    await bot.notify(
      `🔒 ${bot.name}: Live Short Synchronization для ${alert.symbol} @${alert.price}\n` +
        `⏸ Вход заблокирован на 1 час\n` +
        `📅 Разблокировка: ${new Date(Date.now() + 60 * 60 * 1000).toLocaleString()}`,
    );
  }
}
