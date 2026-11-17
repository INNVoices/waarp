# 05. Источники и границы доказательств

**Проверка ссылок/содержания: 17.11.2026.** Это аннотированный реестр, не утверждение о выполненных нами сетевых измерениях. Машинный индекс — [sources.json](sources.json). Ссылки на код закреплены SHA или tag, когда это возможно.

`FULL` — доступен полный текст страницы/документа. `EXCERPT` — проверены относящиеся к выводу фрагменты исходника или индексированный текст; полный материал мог быть недоступен веб-загрузчику. `PDF` — просмотрена соответствующая страница PDF. `CLAIM` — заявление автора проекта, а не наша interop/полевая приёмка. Для изменяемой веб-документации дата проверки не равна дате возникновения функции.

В страновых карточках короткие ID — ссылки на приведённые здесь основания, а не самостоятельные утверждения. Открытые публикации не дают исчерпывающей картины всех операторов на текущий час. Историческое `ongoing` не превращается автоматически в «продолжается 17 ноября».

## Глобальные данные и методика

<a id="g01"></a>**G01 — Access Now, Internet shutdowns in 2025.** [Статья](https://www.accessnow.org/internet-shutdowns-2025/). FULL. Опубликована31.03.2026, наблюдения2025. Основание глобального исторического охвата:313 событий в52 странах. Не является актуальным протокольным рейтингом; число событий и количество затронутых стран — разные показатели.

<a id="g02"></a>**G02 — #KeepItOn Annual Report2025.** [PDF](https://www.accessnow.org/wp-content/uploads/2026/03/KeepItOn-Internet-Shutdowns-2025-Annual-Report.pdf). PDF: страница с таблицей географий, индекс3/печатная4, просмотрена изображением. Из неё взят список52 географий в coverage.json. Страна, где наблюдались последствия, не обязательно является инициатором события; cross-border случаи не смешивать с национальными запретами.

<a id="g03"></a>**G03 — Shutdown Tracker Optimization Project.** [Методика](https://www.accessnow.org/guide/shutdown-tracker-optimization-project/). FULL. Данные2016–2025; обновление страницы март2026. Определение события, источники и ограничения регистрации. Отсутствие записи не доказывает отсутствие ограничений.

<a id="g04"></a>**G04 — OONI, Interpreting OONI data.** [Руководство](https://ooni.org/support/interpreting-ooni-data/). EXCERPT. Основание различать аномалию и подтверждённое вмешательство, сопоставлять контрольные результаты и контекст. Не источник рейтинга рабочих VPN.

<a id="g05"></a>**G05 — OONI Probe risks.** [Риски измерений](https://ooni.org/about/risks/). FULL. Измерения могут быть видимыми сети; результаты по умолчанию публикуются, с возможностью отказа. Для Waarp из этого следует собственное предложение: не включать публичное измерение/телеметрию без осознанного согласия. Это не юридическое заключение по отдельной стране.

## Россия

<a id="r01"></a>**R01 — Cloudflare, Russian Internet users are unable to access the open Internet.** [Отчёт](https://blog.cloudflare.com/russian-internet-users-are-unable-to-access-the-open-internet). EXCERPT,26.06.2025; события с09.06.2025. Наблюдения ограничения загрузки примерно после16KB в затронутых сетях. Не переносить автоматически на весь интернет, все протоколы или отдельный WARP endpoint.

<a id="r02"></a>**R02 — Cloudflare service disruption guidance.** [Документация](https://developers.cloudflare.com/support/troubleshooting/general-troubleshooting/service-disruption/). EXCERPT; изменяемая страница проверена17.11.2026. Дополнительное описание российского ограничения. Свежесть страницы не является новым измерением каждого оператора.

<a id="r03"></a>**R03 — OONI, Russia blocked Telegram.** [Измерения](https://explorer.ooni.org/findings/2026-russia-blocked-telegram). EXCERPT,30.03.2026; окно28.02–30.03.2026, рост признаков ограничения в марте. Не подтверждает причины отдельного ноябрьского обрыва Waarp.

<a id="r04"></a>**R04 — Минцифры, сообщения о доступе к сервисам при ограничениях мобильного интернета.** [Официальный канал](https://t.me/s/mintsifry/2605). FULL, исторические сообщения пилота2025. Основание различать мобильный режим ограниченного доступа и фиксированную сеть. Не раскрывает полный актуальный ACL/IP-механизм.

<a id="r05"></a>**R05 — Информация Минцифры от23.04.2026 о расширении перечня.** [Воспроизведение документа](https://base.garant.ru/414109495/). FULL; публикация первичного сообщения в правовой базе. Подтверждает развитие перечня, не доказывает, какие IP/порты доступны конкретной SIM сегодня.

<a id="r06"></a>**R06 — OONI, Russia blocked Bluesky.** [Разбор](https://explorer.ooni.org/findings/2026-russia-blocked-bluesky). EXCERPT,23.04.2026; окно22.03–22.04.2026. Пример расхождения формального изменения ограничения и результатов доступа. Не модель поведения всех доменов.

## Иран

<a id="i01"></a>**I01 — Filterwatch, Network Monitoring October2026.** [Отчёт](https://filter.watch/english/2026/11/06/network-monitoring-october-2026-filtering-the-internet-through-pricing/). EXCERPT с доступным текстом раздела сетевых наблюдений;06.11.2026, октябрь2026. MahsaNet: различия пяти ISP, в том числе успешное начало при непригодной передаче и слабый upload после частичного улучшения27.10. Источник не доказывает провал любого VPN у каждого иранского пользователя.

<a id="i02"></a>**I02 — Filterwatch, Network Monitoring September2026.** [Отчёт](https://filter.watch/english/2026/10/14/network-monitoring-september-2026-regime-fear-of-filtering-failure/). EXCERPT;14.10.2026, сентябрь и началооктября. Отдельно обсуждается падение трафика Cloudflare относительно общего иранского трафика. Интервью и технические гипотезы в отчёте не превращать в универсальные packet-count константы.

<a id="i03"></a>**I03 — Filterwatch, Technical breakdown of January shutdown.** [Расследование](https://filter.watch/english/2026/01/16/investigative-report-technical-breakdown-of-the-january-2026-shutdown/). EXCERPT;16.01.2026. Технический контекст январского отключения. Не источник текущего списка разрешённых адресов.

<a id="i04"></a>**I04 — Filterwatch, January: blackout and whitelisted access.** [Отчёт](https://filter.watch/english/2026/01/28/network-monitoring-january-2026-from-regional-disuptions-to-total-blackout-and-whitelisted-access/). EXCERPT;28.01.2026. Частичное/избирательное восстановление. Написание `disuptions` в URL сохранено как опубликовано.

<a id="i05"></a>**I05 — Cloudflare, Iran Internet partially restored May2026.** [Измерения](https://blog.cloudflare.com/iran-internet-partially-restored-may-2026/). EXCERPT;27.05.2026, частичное восстановление26.05 после длительного нового эпизода с28.02. Видимость BGP и фактическая передача не тождественны; майские уровни не приписываются ноябрю.

## Мьянма, Украина, Беларусь, Китай

<a id="m01"></a>**M01 — Human Rights Myanmar/IPCM, Blocking independent media during2025–26 elections.** [Исследование](https://humanrightsmyanmar.org/how-the-military-blocked-independent-media-during-the-2025-6-elections/). EXCERPT; исследовательское окно январь2025–январь2026. Блокирование проверяемых сайтов/ресурсов обхода и различия операторов. Не доля заблокированных VPN-протоколов.

<a id="m02"></a>**M02 — Myanmar Freedom on the Net2026.** [Обзор](https://humanrightsmyanmar.org/myanmar-freedom-on-the-net-2026/). EXCERPT;22.10.2026, основное окно июнь2025–май2026. Повреждения инфраструктуры, отключения и контентные ограничения. Дата публикации не делает каждое наблюдение октябрьским.

<a id="m03"></a>**M03 — iMAP Myanmar2024.** [Отчёт](https://imap.sinarproject.org/reports/2024/imap-myanmar-2024-internet-censorship-report). EXCERPT страницы отчёта; исторические данные2023–2024. Дополнительная база сравнений, не текущая мобильная приёмка.

<a id="u01"></a>**U01 — Freedom House, Ukraine Freedom on the Net2026.** [Страновой обзор](https://freedomhouse.org/country/ukraine/freedom-net/2026). EXCERPT доступного индексированного текста; полный профиль веб-загрузчиком не получен. Использованы только общие отмеченные изменения доступа и инфраструктурные проблемы, не невидимые детали отчёта.

<a id="u02"></a>**U02 — RSF, Russian-occupied Ukrainian territories.** [Первичные свидетельства](https://rsf.org/en/russian-occupied-ukrainian-territories-staying-informed-has-become-clandestine-act). EXCERPT;16.06.2026. Основание отделять контекст оккупированных территорий. Не распространять наблюдения на всех украинских операторов.

<a id="b01"></a>**B01 — Freedom House, Belarus Freedom on the Net2026.** [Обзор](https://freedomhouse.org/country/belarus/freedom-net/2026). EXCERPT; полный профиль веб-загрузчиком не получен. Использован доступный контекст отличия от прежнего ограничения ресурсов вне.by. Нет свежего теста каждого VPN.

<a id="c01"></a>**C01 — GFW Report/USENIX Security2025, QUIC censorship.** [Исследование](https://gfw.report/publications/usenixsecurity25/en/). EXCERPT. Исследует механизм QUIC Initial/SNI; не означает, что весь QUIC заблокирован или весь QUIC обходит фильтр.

<a id="c02"></a>**C02 — GFW Report/USENIX Security2023, fully encrypted traffic.** [Исследование](https://gfw.report/publications/usenixsecurity23/en/). EXCERPT. Полностью зашифрованный внешний вид не гарантирует нераспознаваемость. Историческая работа, не карта ноября2026.

<a id="c03"></a>**C03 — GFW Report/IEEE S&P2025, regional censorship.** [Исследование](https://gfw.report/publications/sp25/en/). EXCERPT. Основание учитывать региональную неоднородность, в частности Henan. Не универсальный fingerprint или список работающих входов.

## Дополнительные географии

<a id="w01"></a>**W01 — OONI, Media censorship in India and Pakistan.** [Отчёт2025](https://ooni.org/post/2025-media-censorship-in-india-and-pakistan/). EXCERPT; события апреля–мая2025. Различает платформенные и сетевые ограничения, полезен для диагностической классификации.

<a id="w02"></a>**W02 — OONI, Pakistan X restrictions.** [Карточка](https://explorer.ooni.org/findings/2025-pakistan-blocked-twitterx-). EXCERPT; снятие наблюдавшегося ограничения в мае2025. Завершающий дефис URL — часть адреса. Не сохранять бессрочный blacklist по историческому событию.

<a id="w03"></a>**W03 — OONI, Kazakhstan2024.** [Отчёт](https://ooni.org/post/2024-kazakhstan-report/). EXCERPT; июнь2023–июнь2024. Сетевые ограничения и TLS/MITM-наблюдения. Не основание отключить проверку сертификата.

<a id="w04"></a>**W04 — OONI, Türkiye throttling social media.** [Исследование](https://ooni.org/post/2025-turkiye-throttling-social-media/). EXCERPT;20.11.2025, март/сентябрь2025. Контрольная методика отделяет ограничение от общей деградации лучше одного speedtest.

<a id="w05"></a>**W05 — OONI, Uganda following2026 election.** [Карточка](https://explorer.ooni.org/findings/2026-uganda-blocked-social-media-following-2026-general-election). EXCERPT; январь2026. Различает общее отключение и остаточные ограничения платформ. Не текущий универсальный статус страны.

<a id="w06"></a>**W06 — OONI, Gabon social media.** [Карточка](https://explorer.ooni.org/findings/2026-gabon-blocked-social-media). EXCERPT; признаки с18.02.2026, ограниченное количество измерений явно учитывается.

<a id="w07"></a>**W07 — OONI, Guinea Facebook/TikTok/YouTube.** [Карточка](https://explorer.ooni.org/findings/2026-guinea-blocked-facebook-tiktok-and-youtube). EXCERPT; эпизод с27.07.2026. Надпись ongoing в карточке не подтверждает непрерывность до даты этого корпуса.

<a id="w08"></a>**W08 — OONI, LaLiga collateral blocking.** [Разбор](https://ooni.org/post/2026-laliga-collateral/). EXCERPT;30.06.2026, январь–июнь2026. Побочные отказы общей CDN-инфраструктуры в Испании. Пример временной/адресной корреляции, не общего запрета VPN.

<a id="w09"></a>**W09 — OONI, Women on Web blocked.** [Исследование](https://ooni.org/post/2026-women-on-web-blocked/). EXCERPT;11.06.2026,01.11.2025–01.04.2026. Семь выборочных географий: Иран, Турция, Филиппины, Южная Корея, Испания, Кувейт, Аргентина. Аргентинское наблюдение временное/сетево-ограниченное; не приписывать намерение без основания.

<a id="w10"></a>**W10 — iMAP regional reports2024.** [Коллекция](https://imap.sinarproject.org/reports/2024). EXCERPT оглавления и описания периода; июль2023–июнь2024. Камбоджа, Гонконг, Индия, Индонезия, Малайзия, Мьянма, Филиппины, Таиланд, Вьетнам. Источник направлений дальнейшей проверки; все девять полных PDF в этой работе не перечитаны.

<a id="w11"></a>**W11 — Measuring Internet censorship in Turkmenistan.** [Первичная работа](https://arxiv.org/abs/2304.04835). EXCERPT;2023. Исследовательское основание адресной фильтрации, не актуальный список работающих адресов.

<a id="w12"></a>**W12 — OONI, Italy blocks WoW and WHW.** [Отчёт](https://ooni.org/post/2026-italy-blocks-wow-and-whw/). EXCERPT;28.07.2026, наблюдения до01.06.2026. Выборочные DNS-ограничения; не доказательство закрытого внешнего интернета.

## Протоколы и платформы

<a id="p01"></a>**P01 — v2rayNG2.4.0.** [Релиз](https://github.com/2dust/v2rayNG/releases/tag/2.4.0). FULL release metadata;12.11.2026, pre-release. Поддержка формата не равна полевой устойчивости.

<a id="p02"></a>**P02 — v2rayNG PR6402.** [MASQUE implementation](https://github.com/2dust/v2rayNG/pull/6402). FULL PR description; merge11.11.2026. Поля/валидация и заявленные автором ручные проверки; не аудит всех25 изменённых файлов.

<a id="p03"></a>**P03 — Xray26.11.9.** [Релиз](https://github.com/XTLS/Xray-core/releases/tag/v26.11.9). FULL release text;09.11.2026. Chrome155+ и утверждение автора о текущем TSPU — CLAIM, не гарантия будущего.

<a id="p04"></a>**P04 — Xray PR7352, XDRIVE.** [Описание эксперимента](https://github.com/XTLS/Xray-core/pull/7352). FULL PR description;09.11.2026. Публичное тестирование, Google Drive backend, согласованные версии, credentials, latency/throughput claims и риски детектирования. Приложенный setup PDF не анализировался; детали из него не выдаются за изученные.

<a id="p05"></a>**P05 — v2rayNG WL fork, exact beta.** [README](https://github.com/FredoWanchampix/v2rayNG/blob/v2.4.2-beta.20261117-021424/README.md). EXCERPT relevant sections; tag17.11.2026. Автор описывает throughput probes и trust-all служебного HTTPS. Заимствование методики не означает доверия binary; криптографический аудит всех реализаций форка не выполнен.

<a id="p06"></a>**P06 — Pinned sing-box-lx configuration.** [MASQUE/режимы/ограничения](https://github.com/Leadaxe/sing-box-lx/blob/f1bac271853eaf13398ce1030c948aebc3aed2e1/docs-lx/lx-config.md). EXCERPT соответствующих разделов. Проверка capabilities на исходнике, не новый запуск распространяемого AAR.

<a id="p07"></a>**P07 — Pinned uTLS client mapping.** [Код](https://github.com/Leadaxe/sing-box-lx/blob/f1bac271853eaf13398ce1030c948aebc3aed2e1/common/tls/utls_client.go). EXCERPT `uTLSClientHelloID`: отдельный `chrome_155`, общий `chrome` через Auto.

<a id="p08"></a>**P08 — Pinned uTLS presets.** [Код](https://github.com/Leadaxe/utls-lx/blob/5b1d579d14864b13e142c3567ddfd4fcd320bf57/u_common.go). EXCERPT: HelloChrome_Auto=HelloChrome_133. Это версионированная истина этого pin, не всех будущих core.

<a id="p09"></a>**P09 — Cloudflare One client firewall requirements.** [Документация](https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/deployment/firewall/). FULL. Требования к доступу инфраструктуры. Enterprise Cloudflare One не отождествлять с consumer WARP enrollment/условиями.

<a id="p10"></a>**P10 — XTLS WARP guide.** [Русская текущая страница](https://xtls.github.io/ru/document/level-2/warp.html). EXCERPT индексированного актуального текста. Английская страница при открытии вернула старый вариант только с WireGuard; он не использован как доказательство современных MASQUE-возможностей. Для конкретного Waarp приоритет уP06.

<a id="p11"></a>**P11 — AmneziaWG official protocol documentation.** [Описание](https://docs.amnezia.org/documentation/amnezia-wg/). EXCERPT. Параметры и эволюция AWG, включая3.x. Маркетинговые заявления об универсальной нераспознаваемости не принимаются как измерение.

<a id="p12"></a>**P12 — NaiveProxy.** [Первичный проект](https://github.com/klzgrad/naiveproxy). EXCERPT README. Использование Chromium networking, собственные серверные и сборочные требования. Не подтверждает наличие полного пути в Waarp.

<a id="p13"></a>**P13 — Hysteria2 URI contract.** [Схема ссылок](https://v2.hysteria.network/docs/developers/URI-Scheme/). EXCERPT; изменяемая документация. [Полная конфигурация](https://v2.hysteria.network/docs/advanced/Full-Client-Config/). Точное наличие поля в Waarp определяется его importer и pinned core; отсутствие импорта нельзя скрывать.

<a id="p14"></a>**P14 — Hysteria Mimic.** [Контракт](https://v2.hysteria.network/docs/advanced/Mimic/). FULL. Linux/root/eBPF, отдельный компонент и ограничения совместимости. Не готовая функция обычного Android без root.

<a id="p15"></a>**P15 — Psiphon tunnel core.** [Проект](https://github.com/Psiphon-Labs/psiphon-tunnel-core). EXCERPT README. Методология управляемых тактик. Лицензия, доступ к инфраструктуре и условия интеграции требуют отдельной проверки.

<a id="p16"></a>**P16 — Tor, connecting from censored regions.** [Операционное руководство](https://support.torproject.org/tor-browser/circumvention/connecting-from-censored-regions/). EXCERPT. obfs4/Snowflake/WebTunnel и региональные рекомендации. Не подтверждает успешность конкретного bridge сейчас.

<a id="p17"></a>**P17 — alias P16.** Тот же Tor guide используется для китайского/белорусского контекста, это не второй независимый источник.

<a id="p18"></a>**P18 — Outline Smart Dialer.** [Спецификация](https://developer.getoutline.org/sdk/reference/smart-dialer-config/). EXCERPT. [Мобильная интеграция](https://developer.getoutline.org/sdk/mobile-app-integration/). Основание изучать типизированные стратегии и переиспользовать существующий сетевой клиент; не требование переносить SDK целиком.

<a id="p19"></a>**P19 — Android VPN.** [Руководство](https://developer.android.com/develop/connectivity/vpn). EXCERPT. [VpnService API](https://developer.android.com/reference/android/net/VpnService). Consent, lifecycle, защита внешних сокетов. Не гарантирует отсутствие OEM-нюансов.

<a id="p20"></a>**P20 — Android network state.** [Руководство](https://developer.android.com/develop/connectivity/network-ops/reading-network-state). EXCERPT. [NetworkCallback](https://developer.android.com/reference/android/net/ConnectivityManager.NetworkCallback). Физическая сеть, capabilities и события, различение Wi-Fi и metered. В Waarp часть этих механизмов уже реализована.

<a id="p22"></a>**P22 — WireGuard conceptual overview.** [Первичное описание](https://www.wireguard.com/). FULL, раздел cryptokey routing/roaming. Обновление peer endpoint по аутентифицированному источнику. Проверка конфликта одной peer identity на двух устройствах — диагностический вывод, не установленный диагноз случая владельца.

<a id="p23"></a>**P23 — RFC9484.** [Proxying IP in HTTP](https://www.rfc-editor.org/rfc/rfc9484.html). FULL, октябрь2023. CONNECT-IP, HTTP variants и MTU considerations. Спецификация не доказывает, что конкретный сервер реализует все режимы.

<a id="p24"></a>**P24 — RFC6147.** [DNS64](https://datatracker.ietf.org/doc/html/rfc6147). FULL, апрель2011. СинтезAAAA для взаимодействия с IPv4 через переводчик; основание отдельного теста IPv6-only/NAT64. Не утверждение о текущей сети владельца.

## Новые исследовательские направления

<a id="f01"></a>**F01 — QUICstep, PETS2026.** [Работа](https://gfw.report/publications/pets26a/en/). EXCERPT. [Страница издания](https://petsymposium.org/popets/2026/popets-2026-0014.php). Разделение handshake и дальнейшего QUIC-пути; применимость ограничена допущениями. Не обход отсутствующего/IP-заблокированного канала.

<a id="f02"></a>**F02 — CircumVolve, CCS2026.** [Работа](https://gfw.report/publications/ccs26/en/). EXCERPT; публикация16.11.2026. Автоматизированный исследовательский поиск стратегий; авторские полевые результаты не перенесены на Waarp. Прикладной вывод — offline lab, review, только ограниченные декларативные варианты после проверки.

<a id="f03"></a>**F03 — OONI TLS middlebox experiment.** [Публикация](https://ooni.org/post/2026-ooni-probe-tls-middlebox-experiment/). EXCERPT;10.11.2026, full-page fetch недоступен. Направление измерительного R&D. Не включать потенциально публичные/видимые сети измерения на устройствах автоматически.

## Собственный код и действующее ТЗ

ВсеL-ссылки закреплены `866d0378600c73b75607652118fcf703209ac534`. Source-level аудит не заменяет GUI/сетевой запуск.

<a id="l01"></a>**L01 — TZ-NEXT.** [Действующее ТЗ](https://github.com/INNVoices/waarp/blob/866d0378600c73b75607652118fcf703209ac534/docs/TZ-NEXT-2026-11.md). EXCERPT relevant sections. Новый корпус дополняет, не отменяет существующие этапы и границы.

<a id="l02"></a>**L02 — TZ-PROGRESS.** [Журнал](https://github.com/INNVoices/waarp/blob/866d0378600c73b75607652118fcf703209ac534/docs/TZ-PROGRESS.md). EXCERPT приёмки. Уже выполненное и NOT_RUN разделены; Э7 частично открыт. Старые PASS не объявляются повторно выполненными.

<a id="l03"></a>**L03 — Android native lock / runtime contract.** [Lock](https://github.com/INNVoices/waarp/blob/866d0378600c73b75607652118fcf703209ac534/android/native-source.json), [Android documentation](https://github.com/INNVoices/waarp/blob/866d0378600c73b75607652118fcf703209ac534/docs/ANDROID.md). EXCERPT lock; документация runtime прочитана. Source capabilities и бинарные гарантии не смешивать.

<a id="l04"></a>**L04 — Android ProfileImporter.** [Код](https://github.com/INNVoices/waarp/blob/866d0378600c73b75607652118fcf703209ac534/android/app/src/main/java/local/waarp/android/data/ProfileImporter.kt). EXCERPT1–395. Подтверждает allowlists, Firefox-default, AWG1/2 и ограничения расширенных полей.

<a id="l05"></a>**L05 — Desktop VLESS importer.** [Код](https://github.com/INNVoices/waarp/blob/866d0378600c73b75607652118fcf703209ac534/src/main/vless.ts). EXCERPT1–90. Fingerprints, default и маппинг; не runtime-запуск.

<a id="l06"></a>**L06 — Desktop other links.** [Код](https://github.com/INNVoices/waarp/blob/866d0378600c73b75607652118fcf703209ac534/src/main/links.ts). EXCERPT1–95. Поддерживаемые URI и политика TLS; не всеforeignJSON принимаются.

<a id="l07"></a>**L07 — Android HomeRoutes.** [Код](https://github.com/INNVoices/waarp/blob/866d0378600c73b75607652118fcf703209ac534/android/app/src/main/java/local/waarp/android/ui/HomeRoutes.kt). EXCERPT1–155. OperationFeedback в потоке карточки и разные состояния nativeVPN.

<a id="l08"></a>**L08 — Android UiComponents.** [Код](https://github.com/INNVoices/waarp/blob/866d0378600c73b75607652118fcf703209ac534/android/app/src/main/java/local/waarp/android/ui/UiComponents.kt). EXCERPT1–145. Условная вставка success/error InlineMessage меняет состав layout. Геометрия на живом телефоне в этой работе не измерена.

## Как поддерживать реестр

Добавлять новый источник с периодом наблюдений, типом доказательства и ограничением. При невозможности открыть полный текст сохранять EXCERPT, не выдумывать подробности. При изменении core фиксировать новый SHA и повторно проверять capability gaps. Исторические документы не удалять: они нужны для понимания изменения методов, но не для бессрочного решения Auto.
