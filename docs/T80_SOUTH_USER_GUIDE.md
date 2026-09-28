# Manual rápido do Jasytata
## Planejamento de novos campos para o T80-South

O **Jasytata** permite continuar um projeto usando catálogos de apontamentos existentes ou iniciar um novo plano de cobertura a partir do survey ativo. O catálogo é opcional.

Dois fluxos comuns:

- **A. Continuar um projeto ou levantamento:** carregue um ou mais catálogos, confira o instrumento associado a cada um e planeje uma região para acrescentar novos tiles.
- **B. Iniciar um projeto:** mantenha o survey desejado ativo e planeje a região sem carregar catálogos. O survey fornece a política de planejamento e seu instrumento vinculado fornece a geometria dos novos tiles.

---

# 1. Acessando o Jasytata

Abra o Jasytata no navegador.

Aplicação pública:

**https://elacerda.github.io/jasytata/**

O planejamento, a cobertura e a exportação são executados no navegador. Não é necessário iniciar um servidor. O mapa Aladin Lite e as imagens astronômicas podem acessar serviços externos.

O perfil de referência S-PLUS/T80-South vem incluído e selecionado por padrão.
Ao abrir a página, o survey deve aparecer como:

**S-PLUS / T80-South**

O Jasytata resolve automaticamente o instrumento de saída **T80-South camera** pelo survey ativo. Para o uso normal do T80-South, **não é necessário alterar o survey nem configurar o instrumento de saída**.

Sem catálogos carregados, o survey ativo é suficiente para planejar novos campos.

O seletor **Active survey**, na seção **Survey profile**, define a política usada para gerar os novos tiles. Perfis Schema v2 importados ficam disponíveis imediatamente nessa lista e nos seletores de instrumento dos catálogos durante a sessão atual. Eles permanecem na memória do navegador até recarregar a página. **Export survey JSON** salva o survey selecionado junto com seu instrumento vinculado.

---

# 2. Usando um catálogo existente (opcional)

Para continuar um projeto, clique em:

**Load catalogue**

e escolha o arquivo CSV com os apontamentos já existentes. Para começar um projeto novo pelo perfil, não carregue um catálogo nem use **Load reference**.

O Jasytata procura automaticamente as colunas de **RA** e **DEC**.

Se ele não conseguir identificá-las sozinho, aparecerá uma tela pedindo:

- **RA column** — coluna com ascensão reta;
- **DEC column** — coluna com declinação;
- **Numeric RA unit** — unidade da RA, quando necessário.

Depois clique em:

**Load mapped catalogue**

O catálogo aparecerá sobre o mapa do céu e será considerado no planejamento. Os tiles originais não são alterados.

Cada catálogo tem seu próprio seletor **Catalogue instrument**, que define a geometria usada para interpretar seus apontamentos. O catálogo de referência do T80-South já recebe o instrumento **T80-South camera**. Em uma sessão com vários instrumentos disponíveis, escolha explicitamente o instrumento de cada catálogo enviado; a geometria não é inferida pelo nome do arquivo. O seletor **Inference participation** controla apenas se o catálogo pode ajudar a inferir uma grade: **Exclude** retira o catálogo da inferência, mas seus footprints continuam contribuindo para a cobertura.

### Para testes

O botão **Load reference** carrega o catálogo de exemplo para explorar a ferramenta. Ele não é necessário para iniciar um projeto sem catálogo.

---

# 3. Navegando pelo mapa

O painel central mostra o céu através do Aladin Lite.

Você pode:

- arrastar o mapa para navegar;
- usar o zoom;
- clicar nos centros dos tiles para ver seus dados;
- ligar e desligar camadas no painel **Map layers**.

Ao clicar em um tile, seus detalhes aparecem no painel da direita.

Os tiles do catálogo original são somente para consulta e **não são modificados pelo Jasytata**.

### Importante

Desligar uma camada em **Map layers** apenas esconde essa camada do mapa.

Os campos continuam sendo considerados pelo planejamento.

---

# 4. Selecionando a região que queremos observar

No painel esquerdo, em **Add tiles**, clique em:

**Select area**

Agora marque no mapa os vértices da região desejada.

1. Clique uma vez para cada vértice.
2. Continue até contornar a região que deseja cobrir.
3. Dê **duplo clique** no último ponto para fechar o polígono.

Quando terminar, aparecerá:

**Selected polygon — finalized**

Se precisar refazer a região, use:

**Redraw polygon**

Para apagar a seleção:

**Clear selection**

---

# 5. Gerando os novos campos

Depois de selecionar a região, escolha a estratégia em **Region plan** e clique em:

**Generate plan**

O Jasytata usa a região e o perfil ativo e, se houver, considera também os tiles dos catálogos carregados para calcular os novos tiles.

**Complete coverage** é a opção padrão e tenta cobrir todos os pontos amostrados da região selecionada. Use-a quando precisar de cobertura amostrada exaustiva. Cobertura é uma
estimativa numérica no modelo local, não uma prova geométrica exata. Estruturas
menores que o passo amostral e regiões muito grandes ou polares exigem cuidado;
veja os [limites científicos](ALGORITHM.md#6-deliberate-limitations).

**Efficient coverage**, no perfil S-PLUS/T80-South incluído, usa o mesmo planejador e a mesma ordem de candidatos, mas pode parar depois de atingir pelo menos 99,5% de cobertura amostrada se o próximo tile cobrir, como área nova dentro da região, menos de 3% de sua área física. Ela troca pequenas áreas residuais sem cobertura por menos exposições e não avalia a topologia nem a importância científica dessas lacunas.

Após alguns instantes será exibida uma **Proposal preview**.

Entre as informações mostradas estão:

- **New tiles** — quantidade de novos campos proposta;
- **Already covered** — fração da região que já estava coberta;
- **Final region coverage** — cobertura estimada após adicionar os novos campos;
- **Remaining uncovered** — parte que ainda ficará sem cobertura;
- **Outside selected area** — cobertura que ficará fora do polígono selecionado.

Também aparecerão no mapa os novos centros propostos.

---

# 6. Revise a proposta antes de aceitar

Este é o passo mais importante.

Observe os novos tiles no mapa e confirme se a distribuição faz sentido para a região que pretende observar.

O Jasytata pode indicar:

### Existing grid extended

O programa encontrou campos existentes próximos e conseguiu continuar a grade observacional a partir deles.

Esse é o comportamento esperado quando há informação suficiente do grid ao redor da região.

### Profile fallback

Sem catálogo carregado, esse é o comportamento esperado: o perfil ativo fornece a grade para novos projetos. Com catálogo, o perfil é usado quando os tiles próximos não fornecem informação suficiente para reconstruir a grade local. Em ambos os casos, revise a distribuição dos campos antes de aceitar o plano.

---

# 7. Aceitando ou descartando a proposta

Se o resultado estiver correto, clique em:

**Accept proposal**

Os campos passam para a seção:

**Generated proposal**

Se não gostar do resultado, clique em:

**Cancel preview**

Você poderá redesenhar a região ou gerar um novo plano.

Aceitar uma proposta **não altera o catálogo original**.

---

# 8. Removendo campos que não queremos observar

Depois de aceitar uma proposta, você ainda pode ajustar o plano manualmente.

Clique em um dos tiles propostos.

No painel de detalhes aparecerá:

**Disable tile**

Use esse botão para retirar aquele campo do plano.

Um tile desabilitado continua visível como referência, mas **não será incluído no arquivo final**.

Para colocá-lo novamente no plano:

**Enable tile**

Também existem os comandos:

**Restore all**  
Habilita novamente todos os tiles propostos.

**Disable all**  
Desabilita todos os tiles propostos.

**Clear proposal**  
Apaga completamente a proposta atual.

---

# 9. Exportando os campos para observação

Quando estiver satisfeito com o planejamento, vá para:

**Export new tiles**

Confira o formato mostrado em **Coordinates**: ele pertence à política do
survey ativo. O perfil S-PLUS/T80-South incluído usa **Decimal degrees**, com RA
e DEC em graus decimais; não há um seletor independente de formato por download.

Para usar **Sexagesimal** (RA em horas e DEC em graus), exporte o perfil com
**Export survey JSON**, altere `export.coordinate_format` para `"sexagesimal"`
no JSON e importe uma variante com IDs de instrumento/survey únicos, atualizando
`survey.instrument_id` para o novo ID do instrumento. Selecione essa variante
antes de gerar/aceitar os campos: trocar o survey invalida a proposta atual.
As demais políticas podem ser mantidas para preservar o planejamento T80.
Veja o [guia de perfis](PROFILE_AUTHORING_GUIDE.md#create-or-import-a-profile).

Para o perfil do T80-South incluído, o epoch disponível é:

**2000**

Depois clique em:

**Download new_tiles.csv**

O arquivo gerado contém:

```text
RA,DEC,EPOCH
```

e somente os **novos tiles que estiverem habilitados**.

Exemplo:

```text
RA,DEC,EPOCH
150.50000000,-24.25000000,2000
151.86666667,-24.25000000,2000
```

Esse é o arquivo que deve ser guardado para uso posterior no planejamento da observação.

O preset S-PLUS/T80-South fornece automaticamente as colunas `RA,DEC,EPOCH`,
coordenadas decimais e epoch `2000`. Não é necessário configurar campos de
exportação. O painel mostra o formato definido pelo survey ativo; uma variante
de perfil com `coordinate_format: "sexagesimal"` usa o mesmo formato sexagesimal
histórico (RA em horas e DEC em graus). O formato agora pertence ao perfil,
em vez de ser uma escolha independente em cada download.

---

# 10. Adicionando apenas um campo

Nem sempre é necessário gerar uma região inteira.

Para adicionar manualmente um único apontamento:

1. clique em **Single tile** — não é necessário carregar um catálogo;
2. clique no ponto desejado no mapa;
3. revise a posição;
4. clique em **Accept proposal**.

O campo entrará na proposta da mesma forma que os campos gerados automaticamente.

---

# 11. Importando uma lista de centros

Se você já possui uma lista de coordenadas, use:

**Import centers**

Não é necessário carregar um catálogo para importar centros.

Cole as coordenadas no campo **Paste centers**.

Por exemplo:

```text
RA, DEC
10:03:05, -23:54:31
150.5, -24.25
```

Clique em:

**Validate and preview**

Depois:

**Stage import preview**

Revise os campos no mapa e, se estiverem corretos:

**Accept proposal**

---

# 12. Um cuidado importante: salve seu trabalho

O Jasytata mantém o planejamento atual **apenas na sessão do navegador**.

Isso significa que recarregar a página ou fechar o navegador pode apagar a proposta que estava sendo preparada.

Por isso:

**quando terminar o planejamento, sempre baixe o `new_tiles.csv`.**

Não dependa da página aberta como forma de salvar o trabalho. Se usar uma
variante de perfil, salve também seu JSON; ele guarda configuração, não a
proposta nem o catálogo. Não há persistência por conta ou backend.

---

# Checklist antes de terminar

Antes de usar o arquivo para observação, confira:

- [ ] O perfil mostrado é **S-PLUS / T80-South**.
- [ ] Se estiver continuando um projeto existente, o catálogo correto foi carregado.
- [ ] A região selecionada é a região que deseja observar.
- [ ] Os novos tiles foram revisados visualmente.
- [ ] A cobertura final indicada é adequada ao objetivo.
- [ ] Tiles indesejados foram desabilitados.
- [ ] O formato de coordenadas mostrado pela política do survey é o desejado.
- [ ] O epoch é **2000**.
- [ ] O arquivo **new_tiles.csv** foi baixado.

---

# Resumo em 30 segundos

Confirme o perfil ativo. Se estiver continuando um projeto existente, carregue também o catálogo correspondente; para iniciar um projeto novo, deixe o catálogo vazio.

**1. Select area:** desenhe no céu a região que quer cobrir.

**2. Coverage strategy:** escolha **Complete coverage** para cobertura amostrada exaustiva ou **Efficient coverage** para reduzir exposições.

**3. Generate plan:** revise a proposta e a cobertura estimada.

**4. Accept proposal:** desabilite os tiles indesejados, se necessário.

**5. Download new_tiles.csv:** salve a lista final de centros habilitados.


Pronto.
